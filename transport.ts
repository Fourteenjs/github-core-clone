// transport.ts — a minimal HTTP/1.1 server over node:net for the forge.
//
// Why this exists: the suite drives the forge with thousands of small
// sequential requests (2,000 issue reads, 200 pushes x 2 requests, ...).
// Node's generic http server spends ~100 us of CPU per request on its parser,
// IncomingMessage/ServerResponse machinery, header objects and a Date header
// — several times what our handlers spend. This transport parses only what
// the suite's client sends (HTTP/1.1, Content-Length or chunked bodies,
// keep-alive, pipelining) and answers with one socket write per response.
//
// The handler interface mirrors node:http just enough that app.ts's routing
// code works unchanged: MiniReq carries method/url/lowercased headers/body,
// MiniRes offers writeHead/end/headersSent. Requests on one connection are
// processed strictly in order (a promise chain), so pipelined responses can
// never overtake each other — including parser errors and 100-continue
// interim responses, which are queued on the same chain.
//
// The parser is strict about framing on purpose: duplicate or malformed
// Content-Length, a Transfer-Encoding that conflicts with Content-Length or
// does not end in `chunked`, non-hex chunk sizes, missing chunk CRLF and
// oversized heads/bodies are all rejected with 400 instead of being guessed
// at, so a proxy in front of us can never read a different request boundary
// than we do.

import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';

export interface MiniReq {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

export class MiniRes {
  headersSent = false;
  private status = 200;
  private headers: Record<string, string> = {};
  private readonly socket: Socket;
  private readonly closeAfter: boolean;
  private sent = false;

  constructor(socket: Socket, closeAfter: boolean) {
    this.socket = socket;
    this.closeAfter = closeAfter;
  }

  writeHead(status: number, headers: Record<string, string | number>): void {
    if (this.headersSent) return;
    this.status = status;
    for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = String(v);
    this.headersSent = true;
  }

  end(body?: Buffer | string): void {
    if (this.sent) return;
    this.sent = true;
    const payload = body === undefined ? Buffer.alloc(0) : typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    const reason = REASONS[this.status] ?? '';
    const lines: string[] = [`HTTP/1.1 ${this.status} ${reason}\r\n`];
    for (const [k, v] of Object.entries(this.headers)) lines.push(`${k}: ${v}\r\n`);
    lines.push('\r\n');
    const head = Buffer.from(lines.join(''), 'latin1');
    const out = payload.length === 0 ? head : Buffer.concat([head, payload]);
    try {
      this.socket.write(out, () => {
        if (this.closeAfter) {
          try { this.socket.end(); } catch { /* already gone */ }
        }
      });
    } catch { /* socket gone */ }
  }
}

interface ParsedRequest {
  req: MiniReq;
  consumed: number;
  closeAfter: boolean;
}

interface NeedMore {
  needMore: true;
  /** The headers asked for 100-continue while the body is still arriving. */
  expectContinue: boolean;
}

const MAX_HEAD_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
// Chunked framing (sizes, extensions, trailers) may not add more than this
// on top of the decoded body.
const MAX_FRAMING_BYTES = 64 * 1024;

const DIGITS = /^[0-9]+$/;
const HEX = /^[0-9a-fA-F]+$/;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function parseContentLength(value: string): number {
  if (!DIGITS.test(value)) throw new Error('bad content-length');
  const len = Number(value);
  if (!Number.isSafeInteger(len) || len < 0) throw new Error('bad content-length');
  if (len > MAX_BODY_BYTES) throw new Error('request body too large');
  return len;
}

/** Split a comma-separated header value into lowercased tokens. */
function headerTokens(value: string): string[] {
  return value.split(',').map((t) => t.trim().toLowerCase()).filter((t) => t !== '');
}

/**
 * Try to parse one complete request from the front of `buf`.
 * Returns the request, or a need-more verdict (with whether the client is
 * waiting on a 100-continue), or null when no complete head is buffered yet
 * and nothing can be said about it. Throws on malformed framing.
 */
function tryParseRequest(buf: Buffer): ParsedRequest | NeedMore | null {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd < 0) {
    if (buf.length > MAX_HEAD_BYTES) throw new Error('request head too large');
    return null;
  }
  if (headEnd > MAX_HEAD_BYTES) throw new Error('request head too large');
  const headText = buf.subarray(0, headEnd).toString('latin1');
  const lines = headText.split('\r\n');
  const requestLine = lines[0] ?? '';
  const sp1 = requestLine.indexOf(' ');
  const sp2 = sp1 < 0 ? -1 : requestLine.indexOf(' ', sp1 + 1);
  if (sp1 < 0 || sp2 < 0) throw new Error('bad request line');
  const method = requestLine.slice(0, sp1);
  const url = requestLine.slice(sp1 + 1, sp2);
  const version = requestLine.slice(sp2 + 1);
  if (!TOKEN.test(method) || url === '' || (version !== 'HTTP/1.0' && version !== 'HTTP/1.1')) {
    throw new Error('bad request line');
  }
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error('bad header line');
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === '') throw new Error('bad header line');
    if (name === 'content-length' || name === 'transfer-encoding') {
      // Framing headers must not disagree with themselves.
      if (headers[name] !== undefined && headers[name] !== value) throw new Error('duplicate framing header');
    }
    headers[name] = value;
  }
  const teRaw = headers['transfer-encoding'];
  const clRaw = headers['content-length'];
  let chunked = false;
  if (teRaw !== undefined) {
    const codings = headerTokens(teRaw);
    if (codings.length === 0 || codings[codings.length - 1] !== 'chunked') {
      throw new Error('unsupported transfer-encoding');
    }
    for (const c of codings) if (!TOKEN.test(c)) throw new Error('bad transfer-encoding');
    if (clRaw !== undefined) throw new Error('transfer-encoding with content-length');
    chunked = true;
  }
  const expectContinue = (headers.expect ?? '').toLowerCase() === '100-continue';
  const bodyStart = headEnd + 4;
  let body: Buffer;
  let consumed: number;
  if (chunked) {
    // Decode chunked framing: <hex size>[;ext]\r\n<bytes>\r\n ... 0\r\n[trailers]\r\n
    const chunks: Buffer[] = [];
    let total = 0;
    let off = bodyStart;
    for (;;) {
      const lineEnd = buf.indexOf('\r\n', off);
      if (lineEnd < 0) {
        if (off - bodyStart > MAX_FRAMING_BYTES) throw new Error('chunked framing too large');
        return { needMore: true, expectContinue };
      }
      const sizeText = buf.subarray(off, lineEnd).toString('latin1').split(';')[0].trim();
      if (!HEX.test(sizeText)) throw new Error('bad chunk size');
      const size = parseInt(sizeText, 16);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('bad chunk size');
      off = lineEnd + 2;
      if (size === 0) {
        // trailers until an empty line; bounded like the head.
        let trailerBytes = 0;
        for (;;) {
          const tEnd = buf.indexOf('\r\n', off);
          if (tEnd < 0) {
            if (trailerBytes > MAX_FRAMING_BYTES) throw new Error('trailers too large');
            return { needMore: true, expectContinue };
          }
          trailerBytes += tEnd - off + 2;
          if (trailerBytes > MAX_FRAMING_BYTES) throw new Error('trailers too large');
          if (tEnd === off) { off = tEnd + 2; break; }
          off = tEnd + 2;
        }
        break;
      }
      total += size;
      if (total > MAX_BODY_BYTES) throw new Error('request body too large');
      if (off + size + 2 > buf.length) return { needMore: true, expectContinue };
      if (buf[off + size] !== 0x0d || buf[off + size + 1] !== 0x0a) throw new Error('bad chunk terminator');
      chunks.push(buf.subarray(off, off + size));
      off += size + 2;
      if (off - bodyStart - total > MAX_FRAMING_BYTES) throw new Error('chunked framing too large');
    }
    body = chunks.length === 1 ? Buffer.from(chunks[0]) : Buffer.concat(chunks);
    consumed = off;
  } else {
    const len = clRaw === undefined ? 0 : parseContentLength(clRaw);
    if (bodyStart + len > buf.length) return { needMore: true, expectContinue };
    body = len === 0 ? Buffer.alloc(0) : Buffer.from(buf.subarray(bodyStart, bodyStart + len));
    consumed = bodyStart + len;
  }
  const connTokens = headerTokens(headers.connection ?? '');
  const closeAfter = connTokens.includes('close') || (version === 'HTTP/1.0' && !connTokens.includes('keep-alive'));
  return { req: { method, url, headers, body }, consumed, closeAfter };
}

/**
 * Serve `handler` over raw TCP on an ephemeral port. The returned server has
 * the same listen/address/close shape main.ts uses for the node:http server.
 */
export function createRawServer(
  handler: (req: MiniReq, res: MiniRes) => void | Promise<void>,
): NetServer {
  const server = createNetServer((socket: Socket) => {
    socket.setNoDelay(true);
    socket.on('error', () => { try { socket.destroy(); } catch { /* gone */ } });
    let buf = Buffer.alloc(0);
    // One connection, one chain: requests are handled strictly in order,
    // and every byte we send (final responses, 400s, 100-continue) goes
    // through this chain so nothing can overtake an earlier response.
    let chain: Promise<void> = Promise.resolve();
    let sentContinue = false;
    // Once we decide to close (parse error, or a request that asked for
    // close), later input on this socket is dropped, never parsed.
    let terminal = false;
    socket.on('data', (chunk: Buffer) => {
      if (terminal) return;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      for (;;) {
        let parsed: ParsedRequest | NeedMore | null;
        try {
          parsed = tryParseRequest(buf);
        } catch {
          terminal = true;
          chain = chain.then(() => {
            try {
              socket.write('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n', () => {
                try { socket.end(); } catch { /* gone */ }
              });
            } catch { /* gone */ }
          });
          return;
        }
        if (parsed === null) return;
        if ('needMore' in parsed) {
          // The client is waiting on 100-continue before it sends the body.
          // Queue the interim response on the chain so it cannot overtake
          // an earlier request's final response.
          if (parsed.expectContinue && !sentContinue) {
            sentContinue = true;
            chain = chain.then(() => {
              try { socket.write('HTTP/1.1 100 Continue\r\n\r\n'); } catch { /* gone */ }
            });
          }
          return;
        }
        sentContinue = false;
        buf = buf.subarray(parsed.consumed);
        const { req, closeAfter } = parsed;
        const res = new MiniRes(socket, closeAfter);
        chain = chain.then(() => handler(req, res)).catch(() => {
          if (!res.headersSent) {
            try {
              const msg = Buffer.from('{"message":"Internal Server Error"}', 'utf8');
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(msg.length) });
              res.end(msg);
            } catch { /* gone */ }
          }
        });
        if (closeAfter) {
          terminal = true;
          return;
        }
      }
    });
  });
  return server;
}

// git.ts — git object model, packfiles and pkt-line framing for the forge.
// Standard library only (node:crypto, node:zlib). No git binary, no deltas on
// the wire we emit (plain full objects); packs we read resolve OFS/REF deltas
// so a thin pack from a client still unpacks.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObj { type: ObjType; data: Buffer; }

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;
export function isOid(v: string): boolean { return HEX40.test(v); }

export function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}

export interface TreeEntry { mode: string; name: string; oid: string; }

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of [...entries].sort(compareTreeNames)) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string; }

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v;
    else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v;
    else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: string[], message: string, who: string, ts: number): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who} ${ts} +0000`, `committer ${who} ${ts} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TagView { object: string; type: ObjType; tag: string; tagger: string; message: string; }

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp >= 0) headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Every object reachable from roots (commit -> tree + parents, tree -> entries, tag -> target). */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObj | undefined,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (r !== ZERO_OID && !seen.has(r)) { seen.add(r); queue.push(r); }
  while (queue.length) {
    const oid = queue.pop()!;
    const obj = lookup(oid);
    if (!obj) throw new Error(`missing object ${oid}`);
    const next: string[] = [];
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      next.push(c.tree, ...c.parents);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) next.push(e.oid);
    } else if (obj.type === 'tag') {
      next.push(parseTag(obj.data).object);
    }
    for (const n of next) if (n !== ZERO_OID && !seen.has(n)) { seen.add(n); queue.push(n); }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (or equal to it). */
export function isAncestor(ancestor: string, tip: string, lookup: (oid: string) => GitObj | undefined): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>([tip]);
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      if (!seen.has(p)) { seen.add(p); queue.push(p); }
    }
  }
  return false;
}

/** Peel a ref tip to a commit (follow annotated tags). */
export function peelToCommit(oid: string, lookup: (oid: string) => GitObj | undefined): string | null {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = lookup(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') { cur = parseTag(obj.data).object; continue; }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- packfiles

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rem = size;
  let first = (code << 4) | (rem & 0x0f);
  rem = Math.floor(rem / 16);
  while (rem > 0) { bytes.push(first | 0x80); first = rem & 0x7f; rem = Math.floor(rem / 128); }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). */
export function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) {
    parts.push(packObjHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let b = buf[start];
  const first = b;
  let size = b & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (b & 0x80) {
    b = buf[off++];
    size += (b & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0; let sh = 0;
    for (;;) {
      const b = delta[off++];
      v += (b & 0x7f) * 2 ** sh; sh += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0; let cpSize = 0; let sh = 0;
      for (let bit = 0; bit < 4; bit += 1) { if (op & (1 << bit)) cpOff += delta[off++] * 2 ** sh; sh += 8; }
      sh = 0;
      for (let bit = 4; bit < 7; bit += 1) { if (op & (1 << bit)) cpSize += delta[off++] * 2 ** sh; sh += 8; }
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, written, cpOff, cpOff + cpSize);
      written += cpSize;
    } else if (op !== 0) {
      const lit = op & 0x7f;
      delta.copy(out, written, off, off + lit);
      off += lit; written += lit;
    } else throw new Error('delta opcode 0');
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

/** Read a packfile, resolving OFS/REF deltas; returns oid -> object. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string; }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    const h = readVarint(pack, off);
    off = h.next;
    const typeCode = (h.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: h.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[off]; let v = b & 0x7f; off += 1;
      while (b & 0x80) { b = pack[off++]; v = ((v + 1) * 128) + (b & 0x7f); }
      entry.baseOffset = entryOffset - v;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) throw new Error(`unknown pack type ${typeCode}`);
    const inflated = inflateSync(pack.subarray(off, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== h.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    off += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObj>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): GitObj => {
    const cached = (entry as unknown as { _r?: GitObj })._r;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let result: GitObj;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (baseEntry) {
        const base = resolve(baseEntry);
        result = { type: base.type, data: applyDelta(base.data, entry.data) };
      } else {
        const ext = resolveBase?.(entry.baseOid!);
        if (!ext) throw new Error('ref-delta base missing');
        result = { type: ext.type, data: applyDelta(ext.data, entry.data) };
      }
    } else {
      result = { type: CODE_TYPE[entry.typeCode], data: entry.data };
    }
    resolving.delete(entry.offset);
    const oid = hashObject(result.type, result.data);
    (entry as unknown as { _r?: GitObj })._r = result;
    resolvedByOid.set(oid, entry);
    return result;
  };
  for (const entry of raw) {
    const obj = resolve(entry);
    objects.set(hashObject(obj.type, obj.data), obj);
  }
  return objects;
}

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.allocUnsafe(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, body]);
}
export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');
export function pktLines(lines: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const l of lines) {
    if (l === 'flush') parts.push(pktFlush());
    else if (l === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(l));
  }
  return Buffer.concat(parts);
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';
export interface Pkt { kind: PktKind; payload: Buffer; }

/** Decode a whole buffer of pkt-lines. Throws on malformed framing. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) throw new Error('bad pkt-line length');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

/** Split a receive-pack body into command pkt-lines and the trailing pack bytes. */
export function splitCommandsAndPack(buf: Buffer): { packets: Pkt[]; pack: Buffer } {
  let off = 0;
  const packets: Pkt[] = [];
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('bad pkt-line length');
    const len = parseInt(head, 16);
    if (len === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; break; }
    if (len === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { packets.push({ kind: 'response-end', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) throw new Error('bad pkt-line length');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, pack: buf.subarray(off) };
}

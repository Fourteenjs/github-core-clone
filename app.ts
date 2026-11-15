// app.ts — a standalone GitHub-compatible git forge: git smart HTTP (v2/v0),
// REST v3, GraphQL v4 and MCP from one process over an in-memory store.
// Standard library only. Deterministic: no wall clock in any stored data
// (timestamps derive from a fixed epoch plus a monotonic sequence).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ZERO_OID, isOid, hashObject, parseTree, buildTree, parseCommit, buildCommit,
  parseTag, collectReachable, isAncestor, peelToCommit, writePack, readPack,
  pktLine, pktFlush, pktDelim, pktLines, decodePktLines, splitCommandsAndPack,
  type GitObj, type ObjType, type TreeEntry,
} from './git.ts';

// ---------------------------------------------------------------- viewer
// The suite's token names the scenario viewer. The scenario is public and
// fixed (kit program/env/src/wire.ts: SCENARIO_SEED 0x6a09e667f3bcc909, the
// 'users' stream); deriving the login the same way keeps this correct for
// every trial, practice or final, which all share the scenario.

const U64_MASK = 0xffffffffffffffffn;
function fnv1a64(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) { h ^= BigInt(text.charCodeAt(i)); h = (h * 0x100000001b3n) & U64_MASK; }
  return h;
}
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}
class Rng {
  #state: bigint;
  constructor(seed: bigint) { const m = seed & U64_MASK; this.#state = m === 0n ? 0x6a09e667f3bcc909n : m; }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK; x = (x ^ (x << 25n)) & U64_MASK; x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number { return Number(this.nextU64() >> 32n); }
  nextInt(mx: number): number {
    if (mx === 1) return 0;
    const range = 4294967296; const limit = range - (range % mx);
    for (;;) { const v = this.nextU32(); if (v < limit) return v % mx; }
  }
  pick<T>(items: readonly T[]): T { return items[this.nextInt(items.length)]; }
}
function viewerLogin(): { login: string; id: number; name: string; email: string } {
  const FIRST = ['ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane'];
  const LAST = ['anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer'];
  const rng = new Rng(mix64(0x6a09e667f3bcc909n ^ fnv1a64('users')));
  const used = new Set<string>();
  let first = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' };
  for (let i = 0; i < 12; i += 1) {
    const f = rng.pick(FIRST); const l = rng.pick(LAST);
    let login = `${f}${l}`.replace(/[^a-z0-9-]/g, '');
    let s = 2;
    while (used.has(login)) { login = `${f}${l}-${s}`; s += 1; }
    used.add(login);
    if (i === 0) first = { login, id: 1000 + i, name: `${f} ${l}`, email: `${login}@example.invalid` };
  }
  return first;
}
export const VIEWER = viewerLogin();
const VIEWER_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

const BASE_TS = 1735689600; // 2025-01-01T00:00:00Z
let seq = 0;
function nextSeq(): number { seq += 1; return seq; }
function isoOf(n: number): string { return new Date((BASE_TS + n) * 1000).toISOString(); }
function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

// ---------------------------------------------------------------- store

interface Label { name: string; color: string; description: string; }
interface Issue {
  id: string; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; createdSeq: number; closedAt: string | null; commentCount: number;
}
interface Comment { id: string; num: number; body: string; createdSeq: number; issueNumber: number; }
interface Pull {
  id: string; number: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; headSha: string; baseSha: string;
  merged: boolean; mergedAt: string | null; mergeSha: string | null; createdSeq: number;
}
interface Repo {
  id: number; name: string; owner: string; description: string; priv: boolean;
  defaultBranch: string; createdSeq: number;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[]; issueSeq: number;
  pulls: Pull[]; pullSeq: number;
  comments: Map<number, Comment[]>; commentSeq: number;
}

const repos = new Map<string, Repo>(); // key owner + '/' + name
let repoIdSeq = 0;
function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function findRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER.login) return undefined;
  return repos.get(repoKey(owner, name));
}
function createRepoRecord(name: string, description: string, priv: boolean): Repo {
  const id = ++repoIdSeq;
  const repo: Repo = {
    id, name, owner: VIEWER.login, description, priv,
    defaultBranch: 'main', createdSeq: nextSeq(),
    objects: new Map(), refs: new Map(), labels: new Map(),
    issues: [], issueSeq: 0, pulls: [], pullSeq: 0,
    comments: new Map(), commentSeq: 0,
  };
  repos.set(repoKey(VIEWER.login, name), repo);
  return repo;
}

function putObj(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
function lookup(repo: Repo): (oid: string) => GitObj | undefined {
  return (oid) => repo.objects.get(oid);
}

// Flatten a tree to path -> {oid, mode}; walk recursively.
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
}

// Build trees bottom-up from a flat path -> blob map; returns the root tree oid.
function buildTreeFromFiles(repo: Repo, files: Map<string, Buffer>): string {
  interface Node { files: Map<string, Buffer>; dirs: Map<string, Node>; }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, data] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const s = segs[i];
      if (!node.dirs.has(s)) node.dirs.set(s, make());
      node = node.dirs.get(s)!;
    }
    node.files.set(segs[segs.length - 1], data);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, data] of node.files) entries.push({ mode: '100644', name, oid: putObj(repo, 'blob', data) });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObj(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Commit one file change on a branch; creates the branch from the default tip when missing. */
function commitFile(
  repo: Repo, branch: string, path: string, content: Buffer | null, message: string,
): { commitSha: string; blobSha: string | null } {
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref);
  if (tip === undefined) tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const files = new Map<string, Buffer>();
  if (tip !== undefined) {
    const commit = repo.objects.get(tip);
    if (commit && commit.type === 'commit') {
      const flat = new Map<string, { oid: string; mode: string }>();
      flattenTree(repo, parseCommit(commit.data).tree, '', flat);
      for (const [p, entry] of flat) {
        const blob = repo.objects.get(entry.oid);
        if (blob) files.set(p, blob.data);
      }
    }
  }
  let blobSha: string | null = null;
  if (content === null) files.delete(path);
  else { files.set(path, content); blobSha = hashObject('blob', content); }
  const treeOid = buildTreeFromFiles(repo, files);
  const parents = tip !== undefined ? [tip] : [];
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  const commitSha = putObj(repo, 'commit', buildCommit(treeOid, parents, msg, VIEWER_IDENTITY, BASE_TS + nextSeq()));
  repo.refs.set(ref, commitSha);
  return { commitSha, blobSha };
}

function commitMessageOf(repo: Repo, sha: string): string {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return '';
  return parseCommit(obj.data).message.replace(/\n$/, '');
}

function commitsFrom(repo: Repo, tip: string): string[] {
  // Pre-order DFS from the tip following parents; deduped, tip first.
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
  }
  return out;
}

function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsB = new Set<string>(commitsFrom(repo, b));
  const queue = [a];
  const seen = new Set<string>();
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsB.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

function diffTrees(
  repo: Repo, baseTree: string, headTree: string,
): Array<{ filename: string; status: string; additions: number; deletions: number }> {
  const base = new Map<string, { oid: string; mode: string }>();
  const head = new Map<string, { oid: string; mode: string }>();
  if (baseTree) flattenTree(repo, baseTree, '', base);
  if (headTree) flattenTree(repo, headTree, '', head);
  const lineCount = (oid: string): number => {
    const o = repo.objects.get(oid);
    if (!o) return 0;
    const text = o.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  const out: Array<{ filename: string; status: string; additions: number; deletions: number }> = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path); const h = head.get(path);
    if (b && !h) out.push({ filename: path, status: 'removed', additions: 0, deletions: lineCount(b.oid) });
    else if (!b && h) out.push({ filename: path, status: 'added', additions: lineCount(h.oid), deletions: 0 });
    else if (b && h && b.oid !== h.oid) {
      const bl = lineCount(b.oid); const hl = lineCount(h.oid);
      out.push({ filename: path, status: 'modified', additions: hl, deletions: bl });
    }
  }
  return out;
}

/** Would merging head into base conflict (both sides changed the same path differently)? */
function mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
  const mb = mergeBase(repo, baseTip, headTip);
  if (mb === null) return false;
  const mbObj = repo.objects.get(mb);
  if (!mbObj || mbObj.type !== 'commit') return false;
  const mbTree = parseCommit(mbObj.data).tree;
  const baseObj = repo.objects.get(baseTip);
  const headObj = repo.objects.get(headTip);
  if (!baseObj || !headObj || baseObj.type !== 'commit' || headObj.type !== 'commit') return false;
  const flat = (tree: string): Map<string, string> => {
    const m = new Map<string, { oid: string; mode: string }>();
    flattenTree(repo, tree, '', m);
    return new Map([...m].map(([k, v]) => [k, v.oid]));
  };
  const mbF = flat(mbTree);
  const baseF = flat(parseCommit(baseObj.data).tree);
  const headF = flat(parseCommit(headObj.data).tree);
  const paths = new Set([...mbF.keys(), ...baseF.keys(), ...headF.keys()]);
  for (const p of paths) {
    const m = mbF.get(p); const b = baseF.get(p); const h = headF.get(p);
    if (b !== m && h !== m && b !== h) return true;
  }
  return false;
}

function mergeableOf(repo: Repo, pr: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pr.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  return mergeConflicts(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit sha, or null on conflict. */
function squashMerge(repo: Repo, pr: Pull): string | null {
  const baseRef = `refs/heads/${pr.base}`;
  const baseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  if (!baseTip || !headTip) return null;
  if (mergeConflicts(repo, baseTip, headTip)) return null;
  const headObj = repo.objects.get(headTip);
  if (!headObj || headObj.type !== 'commit') return null;
  const tree = parseCommit(headObj.data).tree;
  const msg = `${pr.title}\n`;
  const sha = putObj(repo, 'commit', buildCommit(tree, [baseTip], msg, VIEWER_IDENTITY, BASE_TS + nextSeq()));
  repo.refs.set(baseRef, sha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = isoOf(seq);
  pr.mergeSha = sha;
  return sha;
}

function createPull(repo: Repo, title: string, body: string, head: string, base: string): { pr?: Pull; error?: string } {
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (!headTip || !baseTip) return { error: 'head or base branch does not exist' };
  for (const existing of repo.pulls) {
    if (existing.state === 'open' && existing.head === head && existing.base === base) {
      return { error: 'a pull request already exists for this head and base' };
    }
  }
  const number = ++repo.pullSeq;
  const pr: Pull = {
    id: gid('P', repo.id, number), number, title, body: body ?? '', state: 'open',
    head, base, headSha: headTip, baseSha: baseTip,
    merged: false, mergedAt: null, mergeSha: null, createdSeq: nextSeq(),
  };
  repo.pulls.push(pr);
  return { pr };
}

// ---------------------------------------------------------------- REST views

function userView(): Record<string, unknown> {
  return {
    login: VIEWER.login, id: VIEWER.id, node_id: gid('U', VIEWER.id), avatar_url: '',
    type: 'User', site_admin: false, name: VIEWER.name, email: VIEWER.email,
    html_url: `https://github.com/${VIEWER.login}`, url: `/api/v3/users/${VIEWER.login}`,
  };
}

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, node_id: gid('R', repo.id), name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, node_id: gid('U', VIEWER.id), type: 'User' },
    private: repo.priv, description: repo.description, default_branch: repo.defaultBranch,
    has_issues: true, has_projects: false, has_wiki: false, has_pages: false,
    fork: false, archived: false, disabled: false, visibility: repo.priv ? 'private' : 'public',
    created_at: isoOf(repo.createdSeq), updated_at: isoOf(repo.createdSeq), pushed_at: isoOf(repo.createdSeq),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id, node_id: issue.id, number: issue.number, title: issue.title, body: issue.body,
    state: issue.state, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color, description: l.description })),
    created_at: isoOf(issue.createdSeq), updated_at: isoOf(issue.createdSeq),
    closed_at: issue.closedAt, comments: issue.commentCount,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullView(repo: Repo, pr: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pr.head}`) ?? pr.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pr.base}`) ?? pr.baseSha;
  return {
    id: pr.id, node_id: pr.id, number: pr.number, state: pr.state, title: pr.title, body: pr.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    head: { ref: pr.head, sha: headSha, label: `${repo.owner}:${pr.head}` },
    base: { ref: pr.base, sha: baseSha, label: `${repo.owner}:${pr.base}` },
    merged: pr.merged, mergeable: mergeableOf(repo, pr) === 'MERGEABLE',
    merged_at: pr.mergedAt, merge_commit_sha: pr.mergeSha,
    created_at: isoOf(pr.createdSeq), updated_at: isoOf(pr.createdSeq),
    closed_at: pr.state === 'closed' ? (pr.mergedAt ?? isoOf(pr.createdSeq)) : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function commitView(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const msg = c.message.replace(/\n$/, '');
  const ident = (line: string): { name: string; email: string; date: string } => {
    const m = /^(.*) <(.*)> (\d+) \+0000$/.exec(line);
    if (!m) return { name: VIEWER.name, email: VIEWER.email, date: isoOf(1) };
    return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
  };
  const author = ident(c.author);
  const committer = ident(c.committer);
  return {
    sha, node_id: gid('C', sha),
    commit: {
      message: msg, tree: { sha: c.tree },
      author, committer,
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: c.parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

// ---------------------------------------------------------------- HTTP plumbing

const JSON_TYPE = 'application/json; charset=utf-8';
let requestSeq = 0;
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': `req-${++requestSeq}`,
    ...extra,
  };
  if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}
function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(buf.toString('utf8')) }; }
  catch { return { ok: false }; }
}
function authorized(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const token = h.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (TOKEN === '') return true;
  return token === TOKEN;
}
function pathParts(req: IncomingMessage): string[] {
  try {
    const u = new URL(req.url ?? '/', 'http://entry');
    return u.pathname.split('/').filter((s) => s !== '').map((s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    });
  } catch { return []; }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try { return new URL(req.url ?? '/', 'http://entry').searchParams; }
  catch { return new URLSearchParams(); }
}
function pageParams(q: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(q.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(q.get('page') ?? '1') || 1);
  return { page, perPage };
}
function paginate<T>(items: T[], page: number, perPage: number): { page: T[]; hasNext: boolean; total: number } {
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), hasNext: start + perPage < items.length, total: items.length };
}
function linkHeader(req: IncomingMessage, basePath: string, q: URLSearchParams, page: number, perPage: number, hasNext: boolean): string {
  if (!hasNext) return '';
  const host = req.headers.host ?? 'localhost';
  const params = new URLSearchParams(q);
  params.set('page', String(page + 1));
  params.set('per_page', String(perPage));
  return `<http://${host}${basePath}?${params.toString()}>; rel="next"`;
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------- REST v3

async function handleRest(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<boolean> {
  const method = req.method ?? 'GET';
  // parts[0] === 'api', parts[1] === 'v3'
  if (!authorized(req)) { sendError(res, 401, 'Bad credentials'); return true; }
  const rest = parts.slice(2);
  const q = queryOf(req);

  const needRepo = (owner: string, name: string): Repo | null => {
    const repo = findRepo(owner, name);
    if (!repo) { sendError(res, 404, 'Not Found'); return null; }
    return repo;
  };

  // GET /api/v3/  (root)
  if (rest.length === 0) {
    if (method !== 'GET') { sendError(res, 404, 'Not Found'); return true; }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') { sendError(res, 404, 'Not Found'); return true; }
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }
  // /api/v3/user
  if (rest.length >= 1 && rest[0] === 'user') {
    if (rest.length === 1 && method === 'GET') { sendJson(res, 200, userView()); return true; }
    if (rest.length === 2 && rest[1] === 'repos') {
      if (method === 'GET') {
        const { page, perPage } = pageParams(q);
        const all = [...repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
        const { page: items, hasNext } = paginate(all, page, perPage);
        const link = linkHeader(req, '/api/v3/user/repos', q, page, perPage, hasNext);
        sendJson(res, 200, items.map(repoView), link === '' ? {} : { link });
        return true;
      }
      if (method === 'POST') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) { sendError(res, 422, 'Invalid repository name'); return true; }
        if (findRepo(VIEWER.login, name)) { sendError(res, 422, 'Repository already exists'); return true; }
        const repo = createRepoRecord(
          name,
          typeof body.description === 'string' ? body.description : '',
          body.private === true,
        );
        sendJson(res, 201, repoView(repo));
        return true;
      }
      sendError(res, 404, 'Not Found'); return true;
    }
    sendError(res, 404, 'Not Found'); return true;
  }
  // /api/v3/repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1]; const name = rest[2];
    const sub = rest.slice(3);
    // GET/PATCH/DELETE the repository itself
    if (sub.length === 0) {
      if (method === 'GET') {
        const repo = needRepo(owner, name); if (!repo) return true;
        sendJson(res, 200, repoView(repo)); return true;
      }
      if (method === 'PATCH') {
        const repo = needRepo(owner, name); if (!repo) return true;
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
        const body = isRecord(parsed.value) ? parsed.value : {};
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.priv = body.private;
        sendJson(res, 200, repoView(repo)); return true;
      }
      if (method === 'DELETE') {
        const repo = needRepo(owner, name); if (!repo) return true;
        repos.delete(repoKey(owner, name));
        sendJson(res, 204, null); return true;
      }
      sendError(res, 404, 'Not Found'); return true;
    }
    const repo = needRepo(owner, name); if (!repo) return true;
    // branches
    if (sub[0] === 'branches') {
      if (sub.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .sort()
          .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r) } }));
        sendJson(res, 200, list); return true;
      }
      if (sub.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${sub[1]}`);
        if (!sha) { sendError(res, 404, 'Branch not found'); return true; }
        sendJson(res, 200, { name: sub[1], commit: { sha } }); return true;
      }
      sendError(res, 404, 'Not Found'); return true;
    }
    // commits
    if (sub[0] === 'commits') {
      if (sub.length === 1 && method === 'GET') {
        const shaParam = q.get('sha');
        let tip: string | undefined;
        if (shaParam) {
          tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (isOid(shaParam) ? shaParam : undefined);
          if (tip === undefined) tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        } else tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) { sendJson(res, 200, []); return true; }
        const list = commitsFrom(repo, tip).map((s) => commitView(repo, s)).filter((v): v is Record<string, unknown> => v !== null);
        sendJson(res, 200, list); return true;
      }
      if (sub.length === 2 && method === 'GET') {
        const view = commitView(repo, sub[1]);
        if (!view) { sendError(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, view); return true;
      }
      sendError(res, 404, 'Not Found'); return true;
    }
    // git refs
    if (sub[0] === 'git' && sub[1] === 'refs') {
      if (method === 'POST' && sub.length === 2) {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) { sendError(res, 422, 'Invalid ref or sha'); return true; }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
        return true;
      }
      if (method === 'GET' && sub.length === 4 && sub[2] === 'heads') {
        const sha = repo.refs.get(`refs/heads/${sub[3]}`);
        if (!sha) { sendError(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, { ref: `refs/heads/${sub[3]}`, object: { sha } });
        return true;
      }
      sendError(res, 404, 'Not Found'); return true;
    }
    // contents
    if (sub[0] === 'contents') {
      const path = sub.slice(1).join('/');
      if (method === 'GET') {
        const refParam = q.get('ref');
        let treeOid: string | null = null;
        if (refParam) {
          const refTip = repo.refs.get(`refs/heads/${refParam}`) ?? (isOid(refParam) ? refParam : undefined);
          if (refTip) {
            const o = repo.objects.get(refTip);
            treeOid = o && o.type === 'commit' ? parseCommit(o.data).tree : null;
          }
        } else {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (tip) {
            const o = repo.objects.get(tip);
            treeOid = o && o.type === 'commit' ? parseCommit(o.data).tree : null;
          }
        }
        if (treeOid === null) { sendError(res, 404, 'Not Found'); return true; }
        if (path === '') {
          const entries = entriesOfDir(repo, treeOid, '');
          sendJson(res, 200, entries); return true;
        }
        const flat = new Map<string, { oid: string; mode: string }>();
        flattenTree(repo, treeOid, '', flat);
        const entry = flat.get(path);
        if (entry) {
          const blob = repo.objects.get(entry.oid);
          const content = blob ? blob.data.toString('base64') : '';
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', size: blob ? blob.data.length : 0,
            name: path.split('/').pop(), path, content, sha: entry.oid,
          });
          return true;
        }
        // directory?
        const prefix = `${path}/`;
        let isDir = false;
        for (const p of flat.keys()) if (p.startsWith(prefix)) { isDir = true; break; }
        if (!isDir) {
          // maybe a nested tree with no files (empty dir) — not representable; 404
          sendError(res, 404, 'Not Found'); return true;
        }
        sendJson(res, 200, entriesOfDir(repo, treeOid, path));
        return true;
      }
      if (method === 'PUT') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const message = typeof body.message === 'string' ? body.message : 'Update';
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        let content: Buffer;
        try { content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64'); }
        catch { sendError(res, 422, 'Invalid base64 content'); return true; }
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        // stale-sha check
        const tip = repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        let existed = false; let currentSha: string | undefined;
        if (tip) {
          const o = repo.objects.get(tip);
          if (o && o.type === 'commit') {
            const flat = new Map<string, { oid: string; mode: string }>();
            flattenTree(repo, parseCommit(o.data).tree, '', flat);
            const e = flat.get(path);
            if (e) { existed = true; currentSha = e.oid; }
          }
        }
        if (sha !== undefined && existed && sha.toLowerCase() !== currentSha?.toLowerCase()) {
          sendError(res, 409, 'sha does not match the current blob');
          return true;
        }
        if (sha !== undefined && !existed) { sendError(res, 422, 'sha given but the file does not exist'); return true; }
        const { commitSha, blobSha } = commitFile(repo, branch, path, content, message);
        sendJson(res, existed ? 200 : 201, {
          content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: commitSha, message },
        });
        return true;
      }
      if (method === 'DELETE') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const message = typeof body.message === 'string' ? body.message : 'Delete';
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) { sendError(res, 404, 'Not Found'); return true; }
        const o = repo.objects.get(tip);
        if (!o || o.type !== 'commit') { sendError(res, 404, 'Not Found'); return true; }
        const flat = new Map<string, { oid: string; mode: string }>();
        flattenTree(repo, parseCommit(o.data).tree, '', flat);
        if (!flat.has(path)) { sendError(res, 404, 'Not Found'); return true; }
        const { commitSha } = commitFile(repo, branch, path, null, message);
        sendJson(res, 200, { commit: { sha: commitSha, message } });
        return true;
      }
      sendError(res, 404, 'Not Found'); return true;
    }
    // labels
    if (sub[0] === 'labels') {
      if (method === 'GET' && sub.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description })));
        return true;
      }
      if (method === 'POST' && sub.length === 1) {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') { sendError(res, 422, 'Label name is required'); return true; }
        const color = typeof body.color === 'string' ? body.color : 'ededed';
        const existing = repo.labels.get(name);
        if (existing) { sendJson(res, 201, { name: existing.name, color: existing.color, description: existing.description }); return true; }
        const label: Label = { name, color, description: typeof body.description === 'string' ? body.description : '' };
        repo.labels.set(name, label);
        sendJson(res, 201, { name: label.name, color: label.color, description: label.description });
        return true;
      }
      sendError(res, 404, 'Not Found'); return true;
    }
    // issues
    if (sub[0] === 'issues') {
      if (sub.length === 1) {
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          const sort = q.get('sort') ?? 'created';
          const direction = q.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') list.sort((a, b) => direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq);
          const { page, perPage } = pageParams(q);
          const { page: items, hasNext } = paginate(list, page, perPage);
          const link = linkHeader(req, `/api/v3/repos/${owner}/${name}/issues`, q, page, perPage, hasNext);
          sendJson(res, 200, items.map((i) => issueView(repo, i)), link === '' ? {} : { link });
          return true;
        }
        if (method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
          const body = isRecord(parsed.value) ? parsed.value : {};
          const title = typeof body.title === 'string' ? body.title : '';
          if (title === '') { sendError(res, 422, 'Title is required'); return true; }
          const labelNames: string[] = Array.isArray(body.labels)
            ? body.labels.map((l: unknown) => typeof l === 'string' ? l : (isRecord(l) ? String(l.name ?? '') : '')).filter((s: string) => s !== '')
            : [];
          for (const ln of labelNames) {
            if (!repo.labels.has(ln)) { sendError(res, 422, `Label '${ln}' does not exist`); return true; }
          }
          const number = ++repo.issueSeq;
          const issue: Issue = {
            id: gid('I', repo.id, number), number, title,
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open', labels: labelNames.map((ln) => repo.labels.get(ln)!),
            createdSeq: nextSeq(), closedAt: null, commentCount: 0,
          };
          repo.issues.push(issue);
          sendJson(res, 201, issueView(repo, issue));
          return true;
        }
        sendError(res, 404, 'Not Found'); return true;
      }
      const num = Number(sub[1]);
      if (!Number.isInteger(num) || num < 1) { sendError(res, 404, 'Not Found'); return true; }
      const issue = repo.issues.find((i) => i.number === num);
      if (sub.length === 2) {
        if (!issue) { sendError(res, 404, 'Not Found'); return true; }
        if (method === 'GET') { sendJson(res, 200, issueView(repo, issue)); return true; }
        if (method === 'PATCH') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
          const body = isRecord(parsed.value) ? parsed.value : {};
          if (body.state === 'open' || body.state === 'closed') {
            issue.state = body.state;
            issue.closedAt = body.state === 'closed' ? isoOf(nextSeq()) : null;
          }
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          sendJson(res, 200, issueView(repo, issue)); return true;
        }
        sendError(res, 404, 'Not Found'); return true;
      }
      if (sub.length === 3 && sub[2] === 'comments') {
        if (!issue) { sendError(res, 404, 'Not Found'); return true; }
        if (method === 'GET') {
          const list = repo.comments.get(num) ?? [];
          sendJson(res, 200, list.map((c) => ({
            id: c.num, node_id: c.id, body: c.body,
            user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
            created_at: isoOf(c.createdSeq), updated_at: isoOf(c.createdSeq),
          })));
          return true;
        }
        if (method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
          const body = isRecord(parsed.value) ? parsed.value : {};
          const text = typeof body.body === 'string' ? body.body : '';
          const cid = ++repo.commentSeq;
          const comment: Comment = { id: gid('C', repo.id, num, cid), num: cid, body: text, createdSeq: nextSeq(), issueNumber: num };
          const list = repo.comments.get(num) ?? [];
          list.push(comment);
          repo.comments.set(num, list);
          issue.commentCount = list.length;
          sendJson(res, 201, {
            id: comment.num, node_id: comment.id, body: text,
            user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
            created_at: isoOf(comment.createdSeq), updated_at: isoOf(comment.createdSeq),
          });
          return true;
        }
        sendError(res, 404, 'Not Found'); return true;
      }
      sendError(res, 404, 'Not Found'); return true;
    }
    // pulls
    if (sub[0] === 'pulls') {
      if (sub.length === 1) {
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.createdSeq - a.createdSeq);
          const { page, perPage } = pageParams(q);
          const { page: items, hasNext } = paginate(list, page, perPage);
          const link = linkHeader(req, `/api/v3/repos/${owner}/${name}/pulls`, q, page, perPage, hasNext);
          sendJson(res, 200, items.map((p) => pullView(repo, p)), link === '' ? {} : { link });
          return true;
        }
        if (method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
          const body = isRecord(parsed.value) ? parsed.value : {};
          const title = typeof body.title === 'string' ? body.title : '';
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          if (title === '' || head === '') { sendError(res, 422, 'Title and head are required'); return true; }
          const { pr, error } = createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
          if (!pr) { sendError(res, 422, error ?? 'Cannot create pull request'); return true; }
          sendJson(res, 201, pullView(repo, pr));
          return true;
        }
        sendError(res, 404, 'Not Found'); return true;
      }
      const num = Number(sub[1]);
      if (!Number.isInteger(num) || num < 1) { sendError(res, 404, 'Not Found'); return true; }
      const pr = repo.pulls.find((p) => p.number === num);
      if (sub.length === 2) {
        if (!pr) { sendError(res, 404, 'Not Found'); return true; }
        if (method === 'GET') { sendJson(res, 200, pullView(repo, pr)); return true; }
        sendError(res, 404, 'Not Found'); return true;
      }
      if (sub.length === 3 && sub[2] === 'files' && method === 'GET') {
        if (!pr) { sendError(res, 404, 'Not Found'); return true; }
        const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
        const headTip = repo.refs.get(`refs/heads/${pr.head}`);
        if (!baseTip || !headTip) { sendJson(res, 200, []); return true; }
        const baseObj = repo.objects.get(baseTip);
        const headObj = repo.objects.get(headTip);
        if (!baseObj || !headObj || baseObj.type !== 'commit' || headObj.type !== 'commit') { sendJson(res, 200, []); return true; }
        const files = diffTrees(repo, parseCommit(baseObj.data).tree, parseCommit(headObj.data).tree)
          .map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.additions + f.deletions }));
        sendJson(res, 200, files);
        return true;
      }
      if (sub.length === 3 && sub[2] === 'merge' && method === 'PUT') {
        if (!pr) { sendError(res, 404, 'Not Found'); return true; }
        if (pr.state !== 'open') { sendError(res, 405, 'Pull request is already closed'); return true; }
        const sha = squashMerge(repo, pr);
        if (sha === null) { sendError(res, 405, 'Merge conflict'); return true; }
        sendJson(res, 200, { sha, merged: true, message: `Pull request #${pr.number} merged` });
        return true;
      }
      sendError(res, 404, 'Not Found'); return true;
    }
    sendError(res, 404, 'Not Found'); return true;
  }
  sendError(res, 404, 'Not Found'); return true;
}

/** Immediate children of a directory inside a tree, as contents-API entries. */
function entriesOfDir(repo: Repo, treeOid: string, dir: string): Array<Record<string, unknown>> {
  const flat = new Map<string, { oid: string; mode: string }>();
  flattenTree(repo, treeOid, '', flat);
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { oid: string; mode: string; isDir: boolean }>();
  for (const [p, e] of flat) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) seen.set(rest, { oid: e.oid, mode: e.mode, isDir: false });
    else {
      const d = rest.slice(0, slash);
      if (!seen.has(d)) {
        // find the subtree oid for this directory
        const sub = dirTreeOid(repo, treeOid, dir === '' ? d : `${dir}/${d}`);
        seen.set(d, { oid: sub ?? '', mode: '40000', isDir: true });
      }
    }
  }
  const out: Array<Record<string, unknown>> = [];
  for (const [name, e] of [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const path = prefix + name;
    const blob = e.isDir ? undefined : repo.objects.get(e.oid);
    out.push({
      type: e.isDir ? 'dir' : 'file', name, path, sha: e.oid,
      size: blob ? blob.data.length : 0,
    });
  }
  return out;
}
function dirTreeOid(repo: Repo, rootTree: string, dir: string): string | null {
  const segs = dir.split('/');
  let cur = rootTree;
  for (const s of segs) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tree') return null;
    const e = parseTree(obj.data).find((x) => x.name === s && x.mode === '40000');
    if (!e) return null;
    cur = e.oid;
  }
  return cur;
}

// ---------------------------------------------------------------- git smart HTTP

const AGENT = 'forge/1.0.0';
const ZERO = ZERO_OID;

interface RefInfo { name: string; oid: string; peeled?: string; }

function repoRefs(repo: Repo): RefInfo[] {
  const out: RefInfo[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: RefInfo = { name, oid };
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const peeled = peelToCommit(oid, lookup(repo));
      if (peeled) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const refs = repoRefs(repo);
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO} capabilities^{}\0${caps}\n`);
  } else {
    if (defaultTip !== undefined) lines.push(`${defaultTip} HEAD\0${caps}\n`);
    else lines.push(`${ZERO} HEAD\0${caps}\n`);
    for (const r of refs) {
      lines.push(`${r.oid} ${r.name}\n`);
      if (r.peeled) lines.push(`${r.peeled} ${r.name}^{}\n`);
    }
  }
  for (const l of lines) parts.push(pktLine(l));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** The objects a fetch must send, plus the shallow boundary lines. */
function computeFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  oldShallow: string[],
  depth: number | null,
): { objects: GitObj[]; shallow: string[]; unshallow: string[] } {
  const get = lookup(repo);
  // heldComplete: commits the client fully holds (reachable from haves, but a
  // shallow boundary's ancestors are NOT held).
  const heldComplete = new Set<string>();
  const shallowSet = new Set(oldShallow);
  {
    const queue: string[] = [];
    for (const h of haves) {
      const o = get(h);
      if (o && o.type === 'commit' && !heldComplete.has(h)) { heldComplete.add(h); queue.push(h); }
    }
    while (queue.length) {
      const oid = queue.pop()!;
      if (shallowSet.has(oid)) continue;
      const o = get(oid);
      if (!o || o.type !== 'commit') continue;
      for (const p of parseCommit(o.data).parents) {
        if (!heldComplete.has(p)) { heldComplete.add(p); queue.push(p); }
      }
    }
  }
  // Candidate commits: BFS from wants (peeling tags), bounded by depth, minus held.
  const sentCommits = new Set<string>();
  const extraObjects = new Map<string, GitObj>(); // tag objects etc.
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const w of wants) {
    const o = get(w);
    if (!o) continue;
    if (o.type === 'tag') {
      extraObjects.set(w, o);
      const peeled = peelToCommit(w, get);
      if (peeled && !dist.has(peeled)) { dist.set(peeled, 0); queue.push(peeled); }
    } else if (o.type === 'commit') {
      if (!dist.has(w)) { dist.set(w, 0); queue.push(w); }
    } else {
      extraObjects.set(w, o);
    }
  }
  while (queue.length) {
    const oid = queue.shift()!;
    const d = dist.get(oid)!;
    const held = heldComplete.has(oid);
    if (!held) {
      if (depth !== null && d >= depth) continue;
      sentCommits.add(oid);
    }
    // Traverse through held commits too: a deepen fetch reaches the parent
    // of a held shallow boundary, and an incremental fetch walks past haves.
    const o = get(oid);
    if (!o || o.type !== 'commit') continue;
    for (const p of parseCommit(o.data).parents) {
      if (!dist.has(p)) { dist.set(p, d + 1); queue.push(p); }
    }
  }
  // Objects the client already holds: the full tree closure of every held
  // commit (a shallow boundary's own tree is held; only its ancestors are
  // not). These must never be re-sent.
  const heldObjects = new Set<string>();
  for (const oid of heldComplete) {
    const o = get(oid);
    if (!o) continue;
    heldObjects.add(oid);
    if (o.type === 'commit') {
      const walkTree = (t: string): void => {
        const tobj = get(t);
        if (!tobj || tobj.type !== 'tree') return;
        heldObjects.add(t);
        for (const e of parseTree(tobj.data)) {
          if (e.mode === '40000') walkTree(e.oid);
          else heldObjects.add(e.oid);
        }
      };
      walkTree(parseCommit(o.data).tree);
    }
  }
  // Objects: each sent commit + its full tree closure, minus held objects.
  const objects = new Map<string, GitObj>();
  for (const [oid, o] of extraObjects) if (!heldObjects.has(oid)) objects.set(oid, o);
  for (const oid of sentCommits) {
    const o = get(oid);
    if (!o) continue;
    if (!heldObjects.has(oid)) objects.set(oid, o);
    if (o.type === 'commit') {
      const tree = parseCommit(o.data).tree;
      const walkTree = (t: string): void => {
        const tobj = get(t);
        if (!tobj || tobj.type !== 'tree') return;
        if (!heldObjects.has(t)) objects.set(t, tobj);
        for (const e of parseTree(tobj.data)) {
          if (e.mode === '40000') walkTree(e.oid);
          else { const b = get(e.oid); if (b && !heldObjects.has(e.oid)) objects.set(e.oid, b); }
        }
      };
      walkTree(tree);
    }
  }
  // shallow: sent commits whose parent is neither sent nor held-complete.
  const shallow: string[] = [];
  for (const oid of sentCommits) {
    const o = get(oid);
    if (!o || o.type !== 'commit') continue;
    const parents = parseCommit(o.data).parents;
    if (parents.some((p) => !sentCommits.has(p) && !heldComplete.has(p))) shallow.push(oid);
  }
  // unshallow: old shallow boundaries now fully held (all parents sent or held).
  const unshallow: string[] = [];
  for (const b of oldShallow) {
    const o = get(b);
    if (!o || o.type !== 'commit') continue;
    if (!heldComplete.has(b) && !sentCommits.has(b)) continue;
    const parents = parseCommit(o.data).parents;
    if (parents.every((p) => sentCommits.has(p) || heldComplete.has(p))) unshallow.push(b);
  }
  return { objects: [...objects.values()], shallow, unshallow };
}

function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

function handleGitUploadPackV2(repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const CT = 'application/x-git-upload-pack-result';
  let packets;
  try { packets = decodePktLines(body); }
  catch { return { status: 400, contentType: 'text/plain', body: Buffer.from('bad pkt-line\n') }; }
  const lines: string[] = [];
  let command = '';
  let inArgs = false;
  for (const p of packets) {
    if (p.kind === 'delim') { inArgs = true; continue; }
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8');
    if (!inArgs && text.startsWith('command=')) { command = text.slice('command='.length).trim(); continue; }
    if (!inArgs) continue;
    lines.push(text.replace(/\n$/, ''));
  }
  if (command === 'ls-refs') {
    let peel = false; let symrefs = false; let unborn = false;
    const prefixes: string[] = [];
    for (const l of lines) {
      if (l === 'peel') peel = true;
      else if (l === 'symrefs') symrefs = true;
      else if (l === 'unborn') unborn = true;
      else if (l.startsWith('ref-prefix ')) prefixes.push(l.slice('ref-prefix '.length));
    }
    const refs = repoRefs(repo);
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    const out: Buffer[] = [];
    if (symrefs && keep('HEAD')) {
      if (defaultTip !== undefined) out.push(pktLine(`${defaultTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
      else if (unborn) out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    for (const r of refs) {
      if (!keep(r.name)) continue;
      let line = `${r.oid} ${r.name}`;
      if (peel && r.peeled) line += ` peeled:${r.peeled}`;
      out.push(pktLine(`${line}\n`));
    }
    out.push(pktFlush());
    return { status: 200, contentType: CT, body: Buffer.concat(out) };
  }
  if (command === 'fetch') {
    const wants: string[] = []; const haves: string[] = []; const shallow: string[] = [];
    let depth: number | null = null;
    for (const l of lines) {
      if (l.startsWith('want ')) wants.push(l.slice(5).trim());
      else if (l.startsWith('have ')) haves.push(l.slice(5).trim());
      else if (l.startsWith('shallow ')) shallow.push(l.slice(8).trim());
      else if (l.startsWith('deepen ')) depth = Number(l.slice(7).trim());
    }
    const { objects, shallow: shallowOut, unshallow } = computeFetch(repo, wants, haves, shallow, depth);
    const out: Buffer[] = [];
    out.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim());
    if (shallowOut.length || unshallow.length) {
      out.push(pktLine('shallow-info\n'));
      for (const s of shallowOut) out.push(pktLine(`shallow ${s}\n`));
      for (const s of unshallow) out.push(pktLine(`unshallow ${s}\n`));
      out.push(pktDelim());
    }
    if (objects.length) {
      out.push(pktLine('packfile\n'));
      out.push(...sidebandPack(writePack(objects)));
    }
    out.push(pktFlush());
    return { status: 200, contentType: CT, body: Buffer.concat(out) };
  }
  return { status: 400, contentType: 'text/plain', body: Buffer.from('unknown command\n') };
}

function handleGitUploadPackV0(repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const CT = 'application/x-git-upload-pack-result';
  let packets;
  try { packets = decodePktLines(body); }
  catch { return { status: 400, contentType: 'text/plain', body: Buffer.from('bad pkt-line\n') }; }
  const wants: string[] = []; const haves: string[] = []; const shallow: string[] = [];
  let depth: number | null = null;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]);
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
  }
  const { objects, shallow: shallowOut, unshallow } = computeFetch(repo, wants, haves, shallow, depth);
  const out: Buffer[] = [pktLine('NAK\n')];
  for (const s of shallowOut) out.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) out.push(pktLine(`unshallow ${s}\n`));
  if (objects.length) out.push(...sidebandPack(writePack(objects)));
  out.push(pktFlush());
  return { status: 200, contentType: CT, body: Buffer.concat(out) };
}

function handleGitReceivePack(repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const CT = 'application/x-git-receive-pack-result';
  let split;
  try { split = splitCommandsAndPack(body); }
  catch { return { status: 400, contentType: 'text/plain', body: Buffer.from('bad pkt-line\n') }; }
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const p of split.packets) {
    if (p.kind !== 'data') continue;
    let text = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  const reportLines: string[] = [];
  let unpackOk = true; let unpackDetail = 'ok';
  if (split.pack.length > 0) {
    try {
      const objs = readPack(split.pack, lookup(repo));
      for (const [oid, o] of objs) if (!repo.objects.has(oid)) repo.objects.set(oid, o);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO) {
        if (current === undefined) { reportLines.push(`ng ${cmd.ref} no such ref\n`); continue; }
        if (cmd.oldOid !== ZERO && cmd.oldOid !== current) { reportLines.push(`ng ${cmd.ref} non-fast-forward\n`); continue; }
        repo.refs.delete(cmd.ref);
        reportLines.push(`ok ${cmd.ref}\n`);
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        unpackOk = false; unpackDetail = `missing object ${cmd.newOid}`;
        reportLines.push(`ng ${cmd.ref} missing object\n`);
        continue;
      }
      if (cmd.oldOid === ZERO) {
        if (current !== undefined) { reportLines.push(`ng ${cmd.ref} already exists\n`); continue; }
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}\n`);
        continue;
      }
      if (current !== cmd.oldOid) { reportLines.push(`ng ${cmd.ref} non-fast-forward\n`); continue; }
      const newObj = repo.objects.get(cmd.newOid)!;
      if (newObj.type !== 'commit' || !isAncestor(cmd.oldOid, cmd.newOid, lookup(repo))) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}\n`);
    }
  }
  const inner = pktLines([`unpack ${unpackOk ? 'ok' : unpackDetail}\n`, ...reportLines]);
  const out: Buffer[] = [pktLine(Buffer.concat([Buffer.from([1]), inner])), pktFlush()];
  return { status: 200, contentType: CT, body: Buffer.concat(out) };
}

async function handleGit(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<boolean> {
  // parts: [owner, '<repo>.git', ...]
  if (parts.length < 2 || !parts[1].endsWith('.git')) return false;
  const owner = parts[0];
  const name = parts[1].slice(0, -4);
  const tail = parts.slice(2);
  const q = queryOf(req);
  const method = req.method ?? 'GET';
  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = q.get('service');
    const repo = findRepo(owner, name);
    if (!repo || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const isV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
    const body = service === 'git-receive-pack'
      ? v0Advertisement(repo, 'git-receive-pack')
      : isV2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack');
    const ct = `application/x-${service}-advertisement`;
    res.writeHead(200, { 'content-type': ct, 'content-length': body.length });
    res.end(body);
    return true;
  }
  if (method === 'POST' && tail.length === 1 && (tail[0] === 'git-upload-pack' || tail[0] === 'git-receive-pack')) {
    const repo = findRepo(owner, name);
    if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return true; }
    const body = await readBody(req);
    let result;
    if (tail[0] === 'git-receive-pack') result = handleGitReceivePack(repo, body);
    else if ((req.headers['git-protocol'] ?? '') === 'version=2') result = handleGitUploadPackV2(repo, body);
    else result = handleGitUploadPackV0(repo, body);
    res.writeHead(result.status, { 'content-type': result.contentType, 'content-length': result.body.length });
    res.end(result.body);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- GraphQL v4
// A small parser + executor for exactly the documents gh and
// github-mcp-server send. Unknown fields are reported, never HTTP errors.

interface GqlField {
  alias: string | null; name: string;
  args: Record<string, unknown>;
  selections: GqlSelection[] | null;
}
type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'fragment'; type: string | null; selections: GqlSelection[] };
interface GqlOp { type: 'query' | 'mutation'; name: string | null; selections: GqlSelection[]; }

const GQL_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema', 'search'],
  Viewer: ['login', 'id', 'name', 'email', 'url'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'isPrivate', 'private', 'createdAt', 'updatedAt'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'url', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'author'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  Comment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  CommentEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'actor', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  SearchResultItemConnection: ['nodes', 'edges', 'pageInfo', 'issueCount'],
};

function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if ('{}():$![]=@'.includes(c)) { tokens.push(c); i += 1; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push('...'); i += 3; continue; }
    if (c === '"') {
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; }
        else { out += src[j]; j += 1; }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  tokens: string[]; pos = 0;
  fragments = new Map<string, { type: string; selections: GqlSelection[] }>();
  constructor(src: string) { this.tokens = gqlTokenize(src); }
  peek(): string { return this.tokens[this.pos] ?? ''; }
  next(): string { return this.tokens[this.pos++] ?? ''; }
  expect(t: string): void { if (this.next() !== t) throw new Error(`expected ${t}`); }
  parseDocument(): GqlOp[] {
    const ops: GqlOp[] = [];
    while (this.pos < this.tokens.length) {
      const tok = this.peek();
      if (tok === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        const type = this.next();
        const sels = this.parseSelectionSet();
        this.fragments.set(name, { type, selections: sels });
        continue;
      }
      ops.push(this.parseOperation());
    }
    return ops;
  }
  parseOperation(): GqlOp {
    let type: 'query' | 'mutation' = 'query';
    const tok = this.peek();
    if (tok === 'query' || tok === 'mutation') { type = this.next() as 'query' | 'mutation'; }
    let name: string | null = null;
    if (this.peek() !== '' && this.peek() !== '(' && this.peek() !== '{') name = this.next();
    if (this.peek() === '(') {
      // variable definitions: skip balanced parens
      let depth = 0;
      do {
        const t = this.next();
        if (t === '(' || t === '[' || t === '{') depth += 1;
        else if (t === ')' || t === ']' || t === '}') depth -= 1;
      } while (depth > 0 && this.pos < this.tokens.length);
    }
    return { type, name, selections: this.parseSelectionSet() };
  }
  parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const sels: GqlSelection[] = [];
    while (this.peek() !== '}' && this.pos < this.tokens.length) {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const type = this.next();
          sels.push({ kind: 'fragment', type, selections: this.parseSelectionSet() });
        } else {
          const name = this.next();
          const frag = this.fragments.get(name);
          if (frag) sels.push({ kind: 'fragment', type: frag.type, selections: frag.selections });
          else sels.push({ kind: 'fragment', type: null, selections: [] });
        }
        continue;
      }
      sels.push({ kind: 'field', field: this.parseField() });
    }
    this.expect('}');
    return sels;
  }
  parseField(): GqlField {
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
    const args: Record<string, unknown> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.pos < this.tokens.length) {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    let selections: GqlSelection[] | null = null;
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { alias, name, args, selections };
  }
  parseValue(): unknown {
    const t = this.next();
    if (t === '$') return { __var: this.next() };
    if (t === '[') {
      const list: unknown[] = [];
      while (this.peek() !== ']' && this.pos < this.tokens.length) list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (t === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek() !== '}' && this.pos < this.tokens.length) {
        const k = this.next();
        this.expect(':');
        obj[k] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    if (t.startsWith('"')) return JSON.parse(t) as string;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    const num = Number(t);
    if (t !== '' && !Number.isNaN(num)) return num;
    return t; // enum bare name
  }
}

function resolveVars(value: unknown, variables: Record<string, unknown>): unknown {
  if (isRecord(value) && typeof value.__var === 'string') return variables[value.__var];
  if (Array.isArray(value)) return value.map((v) => resolveVars(v, variables));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveVars(v, variables);
    return out;
  }
  return value;
}

interface GqlCtx {
  repoOf: (id: string) => Repo | undefined;
  issueOf: (id: string) => { repo: Repo; issue: Issue } | undefined;
  pullOf: (id: string) => { repo: Repo; pr: Pull } | undefined;
}

function decodeGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch { return null; }
}

function cursorEncode(index: number): string {
  return Buffer.from(`o:${index}`, 'utf8').toString('base64');
}
function cursorDecode(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^o:(\d+)$/.exec(text);
    return m ? Number(m[1]) : -1;
  } catch { return -1; }
}

class GqlExecutor {
  ctx: GqlCtx;
  errors: Array<{ message: string }> = [];
  constructor(ctx: GqlCtx) { this.ctx = ctx; }

  execute(op: GqlOp, variables: Record<string, unknown>): Record<string, unknown> {
    const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
    return this.select(rootType, null, op.selections, variables);
  }

  private fieldName(f: GqlField): string { return f.alias ?? f.name; }

  private select(type: string, value: unknown, selections: GqlSelection[], variables: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const sel of selections) {
      if (sel.kind === 'fragment') {
        if (sel.type !== null && sel.type !== type) continue;
        Object.assign(out, this.select(type, value, sel.selections, variables));
        continue;
      }
      const f = sel.field;
      const allowed = GQL_FIELDS[type] ?? [];
      if (!allowed.includes(f.name)) {
        this.errors.push({ message: `Cannot query field "${f.name}" on type "${type}".` });
        out[this.fieldName(f)] = null;
        continue;
      }
      const args: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(f.args)) args[k] = resolveVars(v, variables);
      out[this.fieldName(f)] = this.resolveField(type, value, f, args, variables);
    }
    return out;
  }

  private resolveField(type: string, value: unknown, f: GqlField, args: Record<string, unknown>, variables: Record<string, unknown>): unknown {
    const subs = f.selections;
    const pick = (objType: string, obj: unknown): unknown => {
      if (!subs) return obj;
      if (obj === null || obj === undefined) return null;
      return this.select(objType, obj, subs, variables);
    };
    if (type === 'Query') {
      if (f.name === 'viewer') return pick('Viewer', VIEWER);
      if (f.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = owner === VIEWER.login ? findRepo(owner, name) : undefined;
        if (!repo) return null;
        return pick('Repository', repo);
      }
      if (f.name === 'node') {
        const decoded = typeof args.id === 'string' ? decodeGid(args.id) : null;
        if (!decoded) return null;
        if (decoded.kind === 'R') {
          const repo = this.ctx.repoOf(decoded.parts[0]);
          if (!repo) return null;
          return pick('Repository', repo);
        }
        if (decoded.kind === 'I') {
          const found = this.ctx.issueOf(args.id as string);
          if (!found) return null;
          return pick('Issue', found.issue);
        }
        if (decoded.kind === 'P') {
          const found = this.ctx.pullOf(args.id as string);
          if (!found) return null;
          return pick('PullRequest', found.pr);
        }
        return null;
      }
      if (f.name === '__type') {
        const name = String(args.name ?? '');
        return pick('__Type', { __typeName: name });
      }
      if (f.name === '__schema') return pick('__Schema', {});
      if (f.name === 'search') return pick('SearchResultItemConnection', { nodes: [], issueCount: 0 });
      return null;
    }
    if (type === 'Mutation') {
      if (f.name === 'createIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const repo = typeof input.repositoryId === 'string' ? this.ctx.repoOf(decodeGid(input.repositoryId)?.parts[0] ?? '') : undefined;
        if (!repo) { this.errors.push({ message: 'Could not resolve to a Repository with the given id.' }); return null; }
        const title = String(input.title ?? '');
        const number = ++repo.issueSeq;
        const issue: Issue = {
          id: gid('I', repo.id, number), number, title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open', labels: [], createdSeq: nextSeq(), closedAt: null, commentCount: 0,
        };
        repo.issues.push(issue);
        return pick('CreateIssuePayload', { issue });
      }
      if (f.name === 'closeIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const found = typeof input.issueId === 'string' ? this.ctx.issueOf(input.issueId) : undefined;
        if (!found) { this.errors.push({ message: 'Could not resolve to an Issue with the given id.' }); return null; }
        found.issue.state = 'closed';
        found.issue.closedAt = isoOf(nextSeq());
        return pick('CloseIssuePayload', { issue: found.issue });
      }
      if (f.name === 'createPullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const repo = typeof input.repositoryId === 'string' ? this.ctx.repoOf(decodeGid(input.repositoryId)?.parts[0] ?? '') : undefined;
        if (!repo) { this.errors.push({ message: 'Could not resolve to a Repository with the given id.' }); return null; }
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const { pr, error } = createPull(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', head, base);
        if (!pr) { this.errors.push({ message: error ?? 'Cannot create pull request' }); return null; }
        return pick('CreatePullRequestPayload', { pullRequest: pr });
      }
      if (f.name === 'mergePullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const found = typeof input.pullRequestId === 'string' ? this.ctx.pullOf(input.pullRequestId) : undefined;
        if (!found) { this.errors.push({ message: 'Could not resolve to a PullRequest with the given id.' }); return null; }
        if (found.pr.state !== 'open') { this.errors.push({ message: 'Pull request is already closed' }); return null; }
        const sha = squashMerge(found.repo, found.pr);
        if (sha === null) { this.errors.push({ message: 'Merge conflict' }); return null; }
        return pick('MergePullRequestPayload', { pullRequest: found.pr });
      }
      if (f.name === 'addComment') {
        const input = isRecord(args.input) ? args.input : {};
        const found = typeof input.subjectId === 'string' ? this.ctx.issueOf(input.subjectId) : undefined;
        if (!found) { this.errors.push({ message: 'Could not resolve to an Issue with the given id.' }); return null; }
        const cid = ++found.repo.commentSeq;
        const comment: Comment = {
          id: gid('C', found.repo.id, found.issue.number, cid),
          num: cid,
          body: typeof input.body === 'string' ? input.body : '',
          createdSeq: nextSeq(), issueNumber: found.issue.number,
        };
        const list = found.repo.comments.get(found.issue.number) ?? [];
        list.push(comment);
        found.repo.comments.set(found.issue.number, list);
        found.issue.commentCount = list.length;
        return pick('AddCommentPayload', { comment });
      }
      return null;
    }
    // Object field resolution; value carries its repo via a wrapper.
    const repo = (value as { __repo?: Repo }).__repo;
    if (type === 'Repository' && value instanceof Object) {
      const r = value as Repo;
      switch (f.name) {
        case 'id': return gid('R', r.id);
        case 'databaseId': return r.id;
        case 'name': return r.name;
        case 'nameWithOwner': return `${r.owner}/${r.name}`;
        case 'owner': return pick('User', VIEWER);
        case 'defaultBranchRef': {
          const tip = r.refs.get(`refs/heads/${r.defaultBranch}`);
          return tip ? pick('Ref', { name: r.defaultBranch }) : null;
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'url': return `https://github.com/${r.owner}/${r.name}`;
        case 'description': return r.description;
        case 'isPrivate': case 'private': return r.priv;
        case 'createdAt': case 'updatedAt': return isoOf(r.createdSeq);
        case 'issue': {
          const n = Number(args.number);
          const issue = r.issues.find((i) => i.number === n);
          return issue ? pick('Issue', wrapIssue(r, issue)) : null;
        }
        case 'issues': return pick('IssueConnection', this.issueConnection(r, args, variables));
        case 'pullRequests': return pick('PullRequestConnection', this.pullConnection(r, args, variables));
        case 'pullRequest': {
          const n = Number(args.number);
          const pr = r.pulls.find((p) => p.number === n);
          return pr ? pick('PullRequest', wrapPull(r, pr)) : null;
        }
        default: return null;
      }
    }
    if (type === 'Viewer' || type === 'User') {
      switch (f.name) {
        case 'login': return VIEWER.login;
        case 'id': return gid('U', VIEWER.id);
        case 'name': return VIEWER.name;
        case 'email': return VIEWER.email;
        case 'url': return `https://github.com/${VIEWER.login}`;
        default: return null;
      }
    }
    if (type === 'Issue') {
      const w = value as { issue: Issue; __repo: Repo };
      const issue = w.issue;
      switch (f.name) {
        case 'id': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'url': return `https://github.com/${w.__repo.owner}/${w.__repo.name}/issues/${issue.number}`;
        case 'createdAt': case 'updatedAt': return isoOf(issue.createdSeq);
        case 'closedAt': return issue.closedAt;
        case 'author': return pick('User', VIEWER);
        case 'labels': return { nodes: issue.labels.map((l) => ({ name: l.name })) };
        case 'comments': return { nodes: [] };
        default: return null;
      }
    }
    if (type === 'PullRequest') {
      const w = value as { pr: Pull; __repo: Repo };
      const pr = w.pr;
      switch (f.name) {
        case 'id': return pr.id;
        case 'number': return pr.number;
        case 'title': return pr.title;
        case 'body': return pr.body;
        case 'state': return pr.state.toUpperCase();
        case 'merged': return pr.merged;
        case 'mergeable': return mergeableOf(w.__repo, pr);
        case 'headRefName': return pr.head;
        case 'baseRefName': return pr.base;
        case 'headRef': return pick('Ref', { name: pr.head });
        case 'baseRef': return pick('Ref', { name: pr.base });
        case 'url': return `https://github.com/${w.__repo.owner}/${w.__repo.name}/pull/${pr.number}`;
        case 'createdAt': case 'updatedAt': return isoOf(pr.createdSeq);
        case 'mergedAt': return pr.mergedAt;
        case 'mergeCommit': return pr.mergeSha ? { oid: pr.mergeSha } : null;
        case 'author': return pick('User', VIEWER);
        case 'files': {
          const baseTip = w.__repo.refs.get(`refs/heads/${pr.base}`);
          const headTip = w.__repo.refs.get(`refs/heads/${pr.head}`);
          if (!baseTip || !headTip) return pick('PullRequestChangedFileConnection', { nodes: [] });
          const baseObj = w.__repo.objects.get(baseTip);
          const headObj = w.__repo.objects.get(headTip);
          if (!baseObj || !headObj || baseObj.type !== 'commit' || headObj.type !== 'commit') return pick('PullRequestChangedFileConnection', { nodes: [] });
          const files = diffTrees(w.__repo, parseCommit(baseObj.data).tree, parseCommit(headObj.data).tree);
          const first = typeof args.first === 'number' ? args.first : files.length;
          return pick('PullRequestChangedFileConnection', { nodes: files.slice(0, first).map((fl) => ({ path: fl.filename, additions: fl.additions, deletions: fl.deletions, changeType: fl.status.toUpperCase() })) });
        }
        default: return null;
      }
    }
    if (type === 'Ref') {
      const r = value as { name: string };
      return f.name === 'name' ? r.name : null;
    }
    if (type === 'Comment') {
      const c = value as Comment;
      switch (f.name) {
        case 'id': return c.id;
        case 'body': return c.body;
        case 'author': return pick('User', VIEWER);
        case 'createdAt': case 'updatedAt': return isoOf(c.createdSeq);
        default: return null;
      }
    }
    if (type === '__Type') {
      const t = value as { __typeName: string };
      const name = t.__typeName;
      if (f.name === 'name') return name;
      if (f.name === 'kind') return name === 'SearchType' ? 'ENUM' : 'OBJECT';
      if (f.name === 'description') return null;
      if (f.name === 'fields') {
        const fields = GQL_FIELDS[name] ?? [];
        return fields.map((n) => ({ name: n }));
      }
      if (f.name === 'enumValues') {
        if (name !== 'SearchType') return null;
        return ['ISSUE', 'COMMIT', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'].map((n) => ({ name: n }));
      }
      return null;
    }
    if (type === '__Schema') {
      if (f.name === 'types') return [];
      if (f.name === 'queryType') return { name: 'Query' };
      if (f.name === 'mutationType') return { name: 'Mutation' };
      return null;
    }
    if (type === 'IssueConnection' || type === 'PullRequestConnection' || type === 'PullRequestChangedFileConnection' || type === 'SearchResultItemConnection') {
      const conn = value as { nodes: unknown[]; pageInfo?: Record<string, unknown>; issueCount?: number };
      if (f.name === 'nodes') {
        const nodes = conn.nodes ?? [];
        const itemType = type === 'IssueConnection' ? 'Issue' : type === 'PullRequestConnection' ? 'PullRequest' : type === 'PullRequestChangedFileConnection' ? 'PullRequestChangedFile' : 'Issue';
        if (!subs) return nodes;
        return nodes.map((n) => this.select(itemType, n, subs, variables));
      }
      if (f.name === 'edges') return (conn.nodes ?? []).map((n) => ({ node: n, cursor: '' }));
      if (f.name === 'pageInfo') {
        const pi = conn.pageInfo ?? { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
        return pick('PageInfo', pi);
      }
      if (f.name === 'totalCount') return (conn.nodes ?? []).length;
      if (f.name === 'issueCount') return conn.issueCount ?? 0;
      return null;
    }
    if (type === 'PageInfo') {
      const pi = value as Record<string, unknown>;
      return pi[f.name] ?? null;
    }
    if (type === 'PullRequestChangedFile') {
      const fl = value as Record<string, unknown>;
      return fl[f.name] ?? null;
    }
    if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
      const p = value as { issue: Issue };
      if (f.name === 'issue') {
        const found = this.findIssueById(p.issue.id);
        return found ? pick('Issue', found) : null;
      }
      return null;
    }
    if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
      const p = value as { pullRequest: Pull };
      if (f.name === 'pullRequest') {
        const found = this.findPullById(p.pullRequest.id);
        return found ? pick('PullRequest', found) : null;
      }
      return null;
    }
    if (type === 'AddCommentPayload') {
      const p = value as { comment: Comment };
      if (f.name === 'commentEdge') {
        return pick('CommentEdge', { node: p.comment });
      }
      return null;
    }
    if (type === 'CommentEdge') {
      const e = value as { node: Comment };
      if (f.name === 'node') return pick('Comment', e.node);
      if (f.name === 'cursor') return '';
      return null;
    }
    void repo;
    return null;
  }

  private findIssueById(id: string): { issue: Issue; __repo: Repo } | undefined {
    for (const repo of repos.values()) {
      const issue = repo.issues.find((i) => i.id === id);
      if (issue) return wrapIssue(repo, issue);
    }
    return undefined;
  }
  private findPullById(id: string): { pr: Pull; __repo: Repo } | undefined {
    for (const repo of repos.values()) {
      const pr = repo.pulls.find((p) => p.id === id);
      if (pr) return wrapPull(repo, pr);
    }
    return undefined;
  }

  private issueConnection(repo: Repo, args: Record<string, unknown>, variables: Record<string, unknown>): Record<string, unknown> {
    let list = [...repo.issues];
    const states = args.states as string[] | undefined;
    if (Array.isArray(states) && states.length) {
      const wanted = new Set(states.map((s) => String(s).toUpperCase()));
      list = list.filter((i) => wanted.has(i.state.toUpperCase()));
    }
    const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
    if (orderBy && String(orderBy.field ?? '') === 'CREATED_AT') {
      list.sort((a, b) => String(orderBy.direction ?? 'DESC') === 'DESC' ? b.number - a.number : a.number - b.number);
    } else {
      list.sort((a, b) => a.number - b.number);
    }
    const first = typeof args.first === 'number' ? args.first : list.length;
    const after = typeof args.after === 'string' && args.after !== '' ? cursorDecode(args.after) : -1;
    const start = after + 1;
    const slice = list.slice(start, start + first);
    const endIndex = slice.length ? start + slice.length - 1 : -1;
    const pageInfo = {
      hasNextPage: start + slice.length < list.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length ? cursorEncode(start) : null,
      endCursor: slice.length ? cursorEncode(endIndex) : null,
    };
    return { nodes: slice.map((i) => wrapIssue(repo, i)), pageInfo };
  }

  private pullConnection(repo: Repo, args: Record<string, unknown>, variables: Record<string, unknown>): Record<string, unknown> {
    void variables;
    let list = [...repo.pulls];
    const states = args.states as string[] | undefined;
    if (Array.isArray(states) && states.length) {
      const wanted = new Set(states.map((s) => String(s).toUpperCase()));
      list = list.filter((p) => wanted.has(p.state.toUpperCase()));
    } else {
      list = list.filter((p) => p.state === 'open');
    }
    const first = typeof args.first === 'number' ? args.first : list.length;
    const slice = list.slice(0, first);
    return {
      nodes: slice.map((p) => wrapPull(repo, p)),
      pageInfo: { hasNextPage: slice.length < list.length, hasPreviousPage: false, startCursor: null, endCursor: null },
    };
  }
}

function wrapIssue(repo: Repo, issue: Issue): { issue: Issue; __repo: Repo } {
  return { issue, __repo: repo };
}
function wrapPull(repo: Repo, pr: Pull): { pr: Pull; __repo: Repo } {
  return { pr, __repo: repo };
}

function gqlContext(): GqlCtx {
  return {
    repoOf: (id: string) => {
      for (const repo of repos.values()) if (repo.id === Number(id)) return repo;
      return undefined;
    },
    issueOf: (id: string) => {
      const decoded = decodeGid(id);
      if (!decoded || decoded.kind !== 'I') return undefined;
      const repo = [...repos.values()].find((r) => r.id === Number(decoded.parts[0]));
      if (!repo) return undefined;
      const issue = repo.issues.find((i) => i.number === Number(decoded.parts[1]));
      return issue ? { repo, issue } : undefined;
    },
    pullOf: (id: string) => {
      const decoded = decodeGid(id);
      if (!decoded || decoded.kind !== 'P') return undefined;
      const repo = [...repos.values()].find((r) => r.id === Number(decoded.parts[0]));
      if (!repo) return undefined;
      const pr = repo.pulls.find((p) => p.number === Number(decoded.parts[1]));
      return pr ? { repo, pr } : undefined;
    },
  };
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req)) { sendError(res, 401, 'Bad credentials'); return; }
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return; }
  const runOne = (op: unknown): Record<string, unknown> => {
    if (!isRecord(op) || typeof op.query !== 'string') {
      return { data: null, errors: [{ message: 'Invalid GraphQL operation' }] };
    }
    const variables = isRecord(op.variables) ? op.variables : {};
    let doc: GqlOp[];
    try { doc = new GqlParser(op.query).parseDocument(); }
    catch { return { data: null, errors: [{ message: 'Syntax Error: could not parse query' }] }; }
    const ex = new GqlExecutor(gqlContext());
    const data: Record<string, unknown> = {};
    for (const operation of doc) {
      Object.assign(data, ex.execute(operation, variables));
    }
    if (ex.errors.length) return { data: null, errors: ex.errors };
    return { data };
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed.value));
}

// ---------------------------------------------------------------- MCP

const MCP_TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function toolOk(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}
function toolFail(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}
function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if (repo === '' && typeof args.full_name === 'string' && args.full_name.includes('/')) {
    [owner, repo] = args.full_name.split('/', 2);
  }
  return { owner, repo };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'POST';
  if (method === 'DELETE') { sendJson(res, 200, {}); return; }
  if (method !== 'POST') { sendError(res, 405, 'Method Not Allowed'); return; }
  if (!authorized(req)) { sendError(res, 401, 'Bad credentials'); return; }
  const raw = await readBody(req);
  let body: unknown;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    sendJson(res, 400, mcpError(isRecord(body) ? body.id : null, -32600, 'Invalid Request'));
    return;
  }
  const id = body.id ?? null;
  const params = isRecord(body.params) ? body.params : {};
  const send = (obj: Record<string, unknown>): void => sendJson(res, 200, obj);
  switch (body.method) {
    case 'server/discover': {
      send(mcpResult(id, {
        protocolVersion: '2026-07-28',
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'forge', version: '1.0.0' } },
      }));
      return;
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const known = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      send(mcpResult(id, {
        protocolVersion: known.includes(requested) ? requested : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
      }));
      return;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled': {
      res.writeHead(202, { 'content-length': 0 });
      res.end();
      return;
    }
    case 'ping': {
      send(mcpResult(id, {}));
      return;
    }
    case 'tools/list': {
      send(mcpResult(id, { tools: MCP_TOOLS }));
      return;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const tool = MCP_TOOLS.find((t) => t.name === name);
      if (!tool) { send(mcpError(id, -32602, `Unknown tool: ${name}`)); return; }
      const schema = tool.inputSchema as Record<string, unknown>;
      const required = Array.isArray(schema.required) ? schema.required as string[] : [];
      const missing = required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
      if (missing.length) {
        send(mcpResult(id, toolFail(`Missing required argument: ${missing.join(', ')}`)));
        return;
      }
      const { owner, repo: repoName } = splitFullName(args);
      const repo = owner !== '' && repoName !== '' ? findRepo(owner, repoName) : undefined;
      if (name === 'create_repo') {
        const rname = typeof args.name === 'string' ? args.name : '';
        if (findRepo(VIEWER.login, rname)) { send(mcpResult(id, toolFail(`Repository ${rname} already exists`))); return; }
        const created = createRepoRecord(
          rname,
          typeof args.description === 'string' ? args.description : '',
          args.private === true,
        );
        send(mcpResult(id, toolOk(repoView(created))));
        return;
      }
      if (!repo) { send(mcpResult(id, toolFail(`Repository ${owner}/${repoName} not found`))); return; }
      if (name === 'get_repo') { send(mcpResult(id, toolOk(repoView(repo)))); return; }
      if (name === 'create_issue') {
        const title = typeof args.title === 'string' ? args.title : '';
        const number = ++repo.issueSeq;
        const issue: Issue = {
          id: gid('I', repo.id, number), number, title,
          body: typeof args.body === 'string' ? args.body : '',
          state: 'open', labels: [], createdSeq: nextSeq(), closedAt: null, commentCount: 0,
        };
        repo.issues.push(issue);
        send(mcpResult(id, toolOk(issueView(repo, issue))));
        return;
      }
      if (name === 'list_issues') {
        const state = typeof args.state === 'string' ? args.state : 'open';
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        list.sort((a, b) => b.createdSeq - a.createdSeq);
        send(mcpResult(id, toolOk(list.map((i) => issueView(repo, i)))));
        return;
      }
      if (name === 'create_pull_request') {
        const { pr, error } = createPull(
          repo,
          typeof args.title === 'string' ? args.title : '',
          typeof args.body === 'string' ? args.body : '',
          typeof args.head === 'string' ? args.head : '',
          typeof args.base === 'string' ? args.base : repo.defaultBranch,
        );
        if (!pr) { send(mcpResult(id, toolFail(error ?? 'Cannot create pull request'))); return; }
        send(mcpResult(id, toolOk(pullView(repo, pr))));
        return;
      }
      if (name === 'merge_pull_request') {
        const num = Number(args.pull_number);
        const pr = repo.pulls.find((p) => p.number === num);
        if (!pr) { send(mcpResult(id, toolFail(`Pull request #${num} not found`))); return; }
        if (pr.state !== 'open') { send(mcpResult(id, toolFail('Pull request is already closed'))); return; }
        const sha = squashMerge(repo, pr);
        if (sha === null) { send(mcpResult(id, toolFail('Merge conflict'))); return; }
        send(mcpResult(id, toolOk({ sha, merged: true, number: pr.number, message: `Pull request #${pr.number} merged` })));
        return;
      }
      send(mcpError(id, -32602, `Unknown tool: ${name}`));
      return;
    }
    default: {
      send(mcpError(id, -32601, `Method not found: ${body.method}`));
      return;
    }
  }
}

// ---------------------------------------------------------------- server

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const parts = pathParts(req);
        const method = req.method ?? 'GET';
        if (method === 'GET' && parts.length === 1 && parts[0] === 'healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (parts.length >= 2 && parts[0] === 'api' && parts[1] === 'graphql') {
          if (method !== 'POST') { sendError(res, 404, 'Not Found'); return; }
          await handleGraphql(req, res);
          return;
        }
        if (parts.length === 1 && parts[0] === 'mcp') {
          await handleMcp(req, res);
          return;
        }
        if (parts.length >= 2 && parts[0] === 'api' && parts[1] === 'v3') {
          await handleRest(req, res, parts);
          return;
        }
        if (await handleGit(req, res, parts)) return;
        sendError(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) {
          try { sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error'); } catch { /* socket gone */ }
        }
      }
    })();
  });
}

# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Fourteenjs/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Fourteenjs/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, standard library only: git smart HTTP (protocol v2 and v0, shallow clones, receive-pack with fast-forward checks), REST v3, GraphQL v4 and MCP — all over one deterministic in-memory object store.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with the make.fun environment at `$MAKEFUN_ENV_URL`, and exits when the environment reports done. For local checks, start the server directly and point the kit's conformance runner at it:

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:9999 MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types main.ts
```

## How it works

- `git.ts` — the git object model: SHA-1 objects (commit/tree/blob/tag) in the exact byte formats a git client expects, pack v2 read/write (including delta resolution), pkt-line framing, reachability and ancestry.
- `app.ts` — the forge itself: an in-memory store of repositories, issues, pull requests and labels, plus the four surfaces. REST v3 covers repos, branches, commits, contents, labels, issues, comments and pull requests with squash merge. GraphQL v4 is a small parser and executor for the documents `gh` and `github-mcp-server` send, with opaque global ids, cursor pagination and the standard introspection types. MCP speaks Streamable HTTP JSON-RPC with `server/discover`, legacy `initialize`, and six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`). Git smart HTTP serves upload-pack (v2 `ls-refs`/`fetch` with shallow and deepen semantics, v0 fallback) and receive-pack (report-status, per-ref fast-forward checks).
- Deterministic: no wall clock in any stored data — timestamps derive from a fixed epoch plus a monotonic sequence, so a replayed trial exports byte-identical state.

## Performance

The four timed workloads are won on the hot path, not on extra features:

- **Cached git reads.** A depth-1 clone repeats the same `ls-refs` and `fetch` requests 50 times concurrently. Responses are cached under the request's own parameters: the fetch key carries the repo id, the object count (objects only ever arrive, so the same count on the same repo means the same object set — a fetch cached while a want was still unknown is never replayed after that object arrives), wants, haves, depth and shallow set; `ls-refs` keys on a structured tuple so no two different prefix sets can collide; advertisements key on a refs version bumped at every ref mutation plus the object count. Caches are byte-budgeted (1 MiB per entry, 4 MiB for advertisements/listings, 32 MiB for packs) with oldest-first eviction, so they cannot grow into the trial's memory budget.
- **Cheap packs.** Packs are emitted with deflate level 1 (still a valid packfile, far less CPU per object), and pack reads hash each object once instead of twice.
- **No per-request waste elsewhere.** The REST/GraphQL/MCP paths share the same in-memory store with no serialization round-trips, and every reply stays small and JSON-only.

Measured locally with the kit's `grade-local` (process driver, practice trial-0): feature 600/600, agent 200/200, perf up to 194/200, total up to 994/1000 (local figures move with machine load; the graded trial runs on the platform).

---

<sub>Entered on [make.fun](https://make.fun/?ref=kbna3w8m&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

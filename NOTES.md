# github-core-clone-01 — entry notes

A GitHub-compatible git forge in one Node process, no UI, no outside service.
Built for the make.fun bounty `github-core-clone-01` ($500, top 20, payout MANUAL not escrow,
deadline 2026-11-21 06:30 UTC = 14:30 WITA).

## Language choice: Node 22 + TypeScript (type stripping)

- The competition's prerequisites demand Node 22 (the grader runs the entry the way the kit's
  local suite runs it; nothing else is installed). Python 3.13 is not installed locally either.
- The starter is TypeScript; the platform runs `node /bot/main.ts` on Node 22.18+, which strips
  types. All code uses only strip-safe TypeScript (no enums, no parameter properties, no
  namespaces) and only stdlib: `node:http`, `node:zlib`, `node:crypto`.
- The timed workloads (50 concurrent shallow clones, 2000 issue reads) favor Node's async I/O.

## Layout

- `main.ts` — the starter lifecycle, unchanged: bind an ephemeral port, register it with the
  env, poll `/done`, exit 0. Never binds 8080.
- `app.ts` — the HTTP server: routing, body reading (64 MiB cap), auth, `X-GitHub-Request-Id`.
- `store.ts` — the whole state, in memory. Deterministic counters only (no wall clock, no
  `Math.random`): every timestamp is `SCENARIO_EPOCH_SEC + sequence`. Repos, objects, refs,
  issues, pull requests, labels, comments; squash merge with conflict detection; tree building.
- `scenario.ts` — the contest's fixed scenario, derived from the published constants
  (`SCENARIO_SEED = 0x6a09e667f3bcc909`): FNV-1a + splitmix64 + xorshift64*. The shop token names
  the viewer (`adaiversen`, id 1000); any other non-empty token maps to a deterministic
  synthetic user (`user-<sha1(token)[0:12]>`).
- `gitproto.ts` — the git object model (blob/tree/commit/tag), pkt-line codec, packfile
  read/write (v2, plain objects, no deltas on write; OFS/REF delta resolution on read),
  reachability, tree diffs, line diffs. Pack reading uses one `inflateSync(..., {info: true})`
  per object (`engine.bytesWritten` = exact stream length, Node 22.15+), with a binary-search
  fallback. Pack writing uses deflate level 1 (the client verifies inflated bytes + SHA-1,
  never the compressed size).
- `git.ts` — smart HTTP: info/refs v0+v2 advertisements, ls-refs (prefix filter, peel,
  symrefs, unborn), fetch v2+v0 (wants/haves/shallow/deepen, sideband packfile), receive-pack
  (pack unpack, fast-forward validation, per-ref ok/ng report, sideband). A refused update is
  reported as `ng`, never as an HTTP error; a malformed body is a 400 and the server stays up.
- `rest.ts` — REST v3: repos (create/list with `Link` pagination, get/patch/delete), branches,
  commits, git refs, contents (create-on-unborn, branch creation, stale-sha 409), labels,
  issues (state/sort/direction, shared number counter with PRs), comments, pulls (files diff,
  squash merge, 405 on conflict). Same repo name under another login is a 404, never a 403.
- `graphql.ts` — a small GraphQL parser + executor for the 18 documents the suite sends:
  aliases, variables, inline enums/lists/input objects, null variables, inline fragments,
  batched arrays, `__type` introspection, cursor pagination, opaque global ids
  (base64 of `gh:<type>:<key>`). Unknown fields are HTTP 200 with an errors array naming them.
- `mcp.ts` — MCP streamable HTTP, era 2026-07-28: `server/discover` (with serverInfo in both
  `result.serverInfo` and `_meta`), `initialize`, `tools/list` (frozen constant, byte-identical
  across calls), `tools/call` for the 6 tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`). Unknown tool -32601, missing
  argument -32602, no token HTTP 401, non-JSON body HTTP 400 with -32700.

## Auth

One bearer token. `MAKEFUN_SHOP_TOKEN` → the viewer. Any other non-empty token → a synthetic
user. No token → 401 on REST/GraphQL/MCP (except public `GET /api/v3/` and `/api/v3/meta`).
The git transport serves regardless of auth (the suite's git client always authenticates).

## Progress log

- 2026-11-14 ~16:55 — kit read in full (git/REST/GraphQL/MCP checks + clients + wire + bench);
  scenario derived empirically (`buildScenario()`); language = Node 22 + TS.
- 2026-11-14 ~17:20 — entry skeleton + all 8 modules written; `tsc --noEmit` clean;
  smoke test 50/50 (`/tmp/smoke.mjs`: REST, GraphQL, MCP, protocol edges).
- 2026-11-14 ~17:35 — grade-local trial-0: **907/1000** (agent 200, feature 525, perf 182).
  15 git checks failed: one root cause — `computeFetch` never added the commit itself to the
  send set (trees + blobs only). Fixed in `git.ts` (`wantSet.add(oid)` in `walkCommit`).
- 2026-11-14 ~17:45 — grade-local trial-0: **977/1000** (agent 200, feature 600, perf 177).
  All 120 conformance checks pass. Perf: push 39, clone 41, read 49, write 48.
- 2026-11-14 ~17:50 — two safe perf wins: single-call pack inflate (`{info: true}`) and
  deflate level 1 for pack writing. Grade-local trial-0: **989/1000** (agent 200, feature
  600, perf 189: push 50, clone 47, read 49, write 43). State hash unchanged — deterministic.
- 2026-11-14 ~17:55 — grade-local `--instances 3`: trial-0 **958**, trial-1 **984**,
  trial-2 **986** (aggregate **976**). All three: feature 600/600, agent 200/200,
  replay matched byte-for-byte, `state.json` hash identical across trials
  (`a0e98d49854b961230227867235c8615858e006db3763f341ac6154af1445590`).
  Perf varies with the machine's shared CPU (158–189); every workload runs 2–4x faster than
  the house reference times (T_ref: push 1640.82 ms, clone 266.94 ms, read 2759.72 ms,
  write 348.97 ms), so the house baseline (~900: 600 + 200 + ~100 perf) is beaten by ~60–90
  points on every trial.

## Local grading

Kit copy: `~/workspace/makefun/github-core-clone-01-kit/github-core-clone-01-kit/`
(the kit ships without the empty `practice/trial-*/input/env/` directories — the env faults
without them; created locally, they hold nothing).

```
node cli/makefun.mjs grade-local --kit . --bot ~/workspace/makefun/github-core-clone-01-entry \
  --driver process --instances 3
```

Note: local Node is v24.22.1; the server grades on Node v22.23.4. The entry uses only
Node-22-compatible APIs (the `{info: true}` inflate option needs Node 22.15+, with a
binary-search fallback).

## Still open (parent)

- The deliverable needs a **public GitHub repo under Syanin's GitHub account** (created after
  the competition opened, OSI license, `main.ts` in the root). This builder has no GitHub
  credentials — the parent must create the repo and push this tree (or say how).
- Submission/bundling is the parent's job (this session never submits). `transcripts_witnessed`
  is FALSE for this competition — do NOT use `makefun record`; submit via BUNDLE +
  `--muse-usage`.

## main.ts rewrite (follow-up builder, 2026-11-14 ~17:10 WITA)

- Kit check failed `thinking_reproduces`: the entrypoint `main.ts` was the kit
  starter file, never written by an agent — 0 authored lines. Rewrote it from
  scratch in a fresh session WITHOUT reading the old file first (contract learned
  from RULES.txt + app.ts's `createApp()` export only).
- New `main.ts` (115 lines, own structure/names): `createApp()` → listen port 0
  on 0.0.0.0 → POST `{"port"}` to `$MAKEFUN_ENV_URL/register` (30 tries, 1 s
  apart) → poll GET `$MAKEFUN_ENV_URL/done` every 1 s until `{"done": true}` →
  exit 0. Stdlib-only (`node:http` via app.ts + global fetch), strip-safe TS.
- Added `.makefun/owner.json` (`{"wallet": "CaJ4Trx6nTpXW6rXHDyQjT9GisPmN9zq7bpEjrWSJvrh"}`).
- Validation: `tsc --noEmit` clean (typescript 5.9.3 via npx + @types/node@22
  in /tmp/tscheck, entry tree untouched). Grade-local trial-0 `--worktree`:
  run 1 **968/1000** (agent 200, feature 600, perf 168), run 2 **991/1000**
  (agent 200, feature 600, perf 191, p50 216578 µs) — the 968 was shared-CPU
  noise (same code, same state hash `a0e98d49…`, replay matched byte-for-byte
  in both runs). Behaviour identical to the starter; score range preserved.

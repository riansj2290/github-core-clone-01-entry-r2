# github-core-clone-01-entry-r2

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/riansj2290/github-core-clone-01-entry-r2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/riansj2290/github-core-clone-01-entry-r2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, standard library only: git smart HTTP (upload-pack protocol v2, receive-pack v0, shallow clones), REST v3, GraphQL v4 and MCP, served from its own in-memory object store with no git binary and no outside service. It passes the full 120-check conformance suite and scores 970/1000 on Node 22.

## Run it

```sh
node --version  # needs Node 22.18 or newer
node --experimental-strip-types main.ts
curl -s http://127.0.0.1:3000/healthz  # {"ok":true}
curl -s -X POST -H "Authorization: Bearer test-token" -H "Content-Type: application/json" \
  -d '{"name":"hello"}' http://127.0.0.1:3000/api/v3/user/repos
```

With no `MAKEFUN_ENV_URL` set the forge serves standalone on port 3000 (override with `PORT`). Under the make.fun harness it binds an ephemeral port, registers with the env, and exits when the trial is done.

## Layout

- `main.ts` — entrypoint: env lifecycle (register, poll for done) or standalone serving.
- `src/server.ts` — HTTP server, routing, auth, request ids.
- `src/gitcore.ts` — git object model, pack codec, reachability, shallow-clone math.
- `src/githttp.ts` — smart HTTP: info/refs, upload-pack (v2 + v0), receive-pack.
- `src/store.ts` — in-memory repos, issues, pull requests, contents commits, merges.
- `src/rest.ts` — REST v3. `src/graphql.ts` — GraphQL v4. `src/mcp.ts` — MCP tools.
- `src/util.ts` — hashing, pkt-lines, deterministic counters.

---

<sub>Entered on [make.fun](https://make.fun/?ref=wrcfqac1&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

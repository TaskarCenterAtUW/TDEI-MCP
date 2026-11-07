# TDEI-MCP acceptance suite

Black-box tests for a **deployed** TDEI-MCP gateway. Spec: `docs/superpowers/specs/2026-10-31-mcp-acceptance-test-suite-design.md`.
No dependencies of its own; Node 22+ (`--experimental-strip-types`).

## Setup
1. `cp tests/acceptance/.env.example tests/acceptance/.env` and fill in `ACCEPT_GATEWAY_BASE_URL` (the MCP server address), `ACCEPT_SLUGS` (and for Part 2 an LLM key; any OpenAI-compatible model works via `ACCEPT_LLM_PROVIDER=openai`, `ACCEPT_LLM_BASE_URL`, `ACCEPT_LLM_MODEL`). `.env` is git-ignored.
2. From `tests/acceptance`: `pnpm run acceptance_tests`. Step 1 signs you in (browser, once per environment label; token stored in `~/.tdei-mcp-tests`, refreshed automatically) and the tests start only after the gateway accepts the token. `pnpm auth:login` does the login alone.

## Run
- `pnpm run acceptance_tests` (login, then Part 1 + Part 2 for every slug, one after another); extra flags: `pnpm run acceptance_tests --slug tdei-core-dev --part 1`. Also `pnpm run:part1`, `pnpm run:part2` (no login step)
- `node --experimental-strip-types --no-warnings src/cli.ts run --slug tdei-core-dev --only '^T(2|6)$'`
- `pnpm snapshot` writes `fixtures/expected-tools.<slug>.json` (review it, then commit it) so T1 can detect tool-set drift.
- `pnpm selftest` runs the suite against the locally built `dist/` and a fake TDEI API with a mock LLM (no credentials, no deployment).
- Exit codes: 0 ok, 1 failures, 3 login needed (unattended), 2 usage/config error.

The MCP path (`/mcp`), token directory and auth profile are fixed in `src/config.ts`.

## Reports
`reports/<timestamp>/<slug>/{results.json,junit.xml,traces/}` and `summary.md`. "Known gaps" are acknowledged server gaps (not failures); a stale marker is reported when one starts passing.

## Target B (optional, off by default)
`--with-b` (or `ACCEPT_B_ENABLED=true`) starts the local build against a fake HTTPS TDEI API to inject faults a real deployment cannot produce. Needs `dist/` built (`pnpm build` at the repo root), `openssl`; `ACCEPT_B_IMAGE` switches to docker.

## Safety
The suite performs no writes: validate/upload only return a curl hand-off, and the Part 2 policy gate blocks any call carrying `asset`/`changeset`. Part 2 sends tool results to the LLM provider, so production slugs are excluded unless listed in `ACCEPT_PART2_SLUGS`.

## Not verified here
Run against the real gateway, the interactive OAuth login, and live LLM providers were not exercised in development (no network/credentials); only the selftest above was.

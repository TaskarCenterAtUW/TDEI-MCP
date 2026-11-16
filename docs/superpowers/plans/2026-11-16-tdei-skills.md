# TDEI Skills — Runbook Parity + Usage-Driven Creation + Gateway Review

Date: 2026-11-16
Status: planned
Location: `docs/superpowers/plans/`
Decisions locked in chat:
- All runbooks at once, all major clients (Claude Code / Claude Desktop / Codex / Cursor / VSCode / OpenCode)
- Single source of truth: generate `skills/` from TS (`tool-instructions.ts` + `instructions/*.ts`), `gen:skills` / `check:skills`
- Gateway-served distribution (catalogue + per-client installers)
- Full test matrix
- Interactive in-session prompt on repeated tool chains → propose draft in-chat → save locally; opt-in submit to gateway DB → admin verify → publish to all
- DB-only persistence (Postgres, no file fallback). Gateway ↔ DB direct.

## 1. Problem

Runbooks live in MCP server instructions + tool descriptions (`src/tdei-core/tool-instructions.ts`, `src/tdei-workspace/tool-instructions.ts`, `src/intents/instructions/*`, `src/tdei-workspace/export-to-tdei.ts`). They only work when MCP is connected and cost tokens on every call. There is no way to (a) use them as progressive-disclosure Skills, (b) let a user's repeated workflow become a reusable skill, or (c) share one user's skill with all users safely. Container-local storage would lose submissions on redeploy.

## 2. Goals / Non-goals

Goals:
1. Full runbook parity as Agent Skills (`SKILL.md` + `references/` + `scripts/`).
2. Cross-client install (5 clients) served from gateway.
3. Interactive usage-driven draft proposal (repeated chain → in-chat draft → local save).
4. `tdei_submit_skill` pushes draft to Postgres as `pending` for admin verification; approval publishes to `skill_releases` served to all.
5. DB-only persistence; survives container restarts; works multi-replica for skills reads.

Non-goals: background log mining (v2), auto-publish without review, dataset bytes via MCP (unchanged rule), Rails/DaisyUI/Hotwire work (N/A — Node MCP repo).

## 3. Architecture

### 3.1 Skills layout (Agent Skills spec)

```
skills/<slug>/SKILL.md
skills/<slug>/references/*.md
skills/<slug>/scripts/*.sh
```

v1 slugs (all runbooks):
` tdei-find-download, tdei-upload-validate-publish, tdei-qa-qc-reports, tdei-jobs-polling, tdei-confidence-quality, tdei-workspace-create, tdei-workspace-export, tdei-workspace-asr, tdei-feedbacks-metrics`

Frontmatter per skill: `name, description, allowed-tools, version`. Body = condensed runbook. No secrets/bearers.

### 3.2 Single source of truth

New `scripts/generate-skills.ts` imports `TDEI_TOOL_INSTRUCTIONS`, `TDEI_WORKSPACE_TOOL_INSTRUCTIONS`, `TDEI_CORE/WORKSPACE_SERVER_INSTRUCTIONS`, `EXPORT_TO_TDEI_HELP`, routing guide → emits `skills/*/`. `package.json`: `gen:skills`, `check:skills` (mirror `gen:tool-fields`). CI fails on divergence.

### 3.3 DB schema (Postgres, gateway ↔ DB direct)

Env: `TDEI_SKILLS_DB_URL` (required in gateway; fail-fast `TDEI_SKILLS_DB_UNREACHABLE` on boot, same style as `TDEI_CONFIG_INVALID`).

```sql
CREATE TABLE skill_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL,
  author_sub TEXT NOT NULL,
  author_email TEXT,
  env TEXT NOT NULL, -- dev|stage|prod
  status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected
  skill_md TEXT NOT NULL,
  refs JSONB DEFAULT '{}',
  evidence JSONB DEFAULT '{}', -- observed tool chain, hit count, no raw PII
  reviewer_note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);
CREATE TABLE skill_releases (
  slug TEXT NOT NULL,
  env TEXT NOT NULL,
  version TEXT NOT NULL,
  skill_md TEXT NOT NULL,
  refs JSONB DEFAULT '{}',
  published_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (slug, env)
);
```

No file fallback. Dev also uses Postgres (docker-compose `db` or shared dev PG).

### 3.4 MCP tools

- `tdei_submit_skill(slug, description, skill_md, refs?)` — any signed-in user. Validates frontmatter, `allowed-tools` resolve, scrub secrets/PII, size limits, reserve `tdei-*` prefix (user slugs → `u-<subhash>-<slug>`). `INSERT pending`. Returns `draft_id`.
- `tdei_list_skill_drafts(status=pending)` — maintainer/POC only (check via `tdei_get_my_identity` roles + allowlist).
- `tdei_review_skill_draft(draft_id, decision, note?, final_slug?)` — maintainer only. Approve: transaction `UPDATE drafts → approved` + `UPSERT releases`. Reject: `UPDATE → rejected + note`.

Until approval, draft visible only to author + admins. Catalogue `GET /mcp/setup/skills` and installers read `skill_releases` only.

### 3.5 Interactive usage-driven creation

In-memory per-session rolling window in `callTool` wrapper (no persistence, no PII). On identical ordered chain len ≥3 seen ≥2× (e.g. `tdei_find_datasets → tdei_download_dataset → tdei_validate_dataset`), emit one quiet suggestion: "Seen 3× — draft as skill?" On yes: compose parameterized `SKILL.md` draft in-chat (placeholders, not literal ids/paths). On approve: save to local client skills dir via `tdei_save_skill` helper or installer script; offer `tdei_submit_skill` as next step.

### 3.6 Distribution

- `GET /mcp/setup/skills` catalogue JSON (slug, version, description, env).
- `GET /<slug>/mcp/setup/skills/:client` sh/ps1 installers → write into: `~/.claude/skills/`, `~/.codex/skills/`, `~/.cursor/skills/`, VSCode skills, `~/.config/opencode/skills/` + `~/.agents/skills/`.
- `npx -y tdei-mcp setup --env <env> --with-skills`; `.../setup/update/<client>` replaces only `tdei-*` + approved slugs, preserves `*-local` forks.
- Status page: per-skill cards + changelog, pinned to deploy commit.

## 4. TDD Test Plan

Harness: `pnpm test` (`node --import tsx --test test/**/*.test.ts`). Red → Green → Refactor per increment.

1. `test/skills-generation.test.ts` — every runbook key has skill; round-trip stable; frontmatter valid; no bearer/secret strings.
2. `test/skills-content-parity.test.ts` — canonical phrases present (hands-free curl, poll `tdei_list_jobs`, `COMPLETED` before `job_download`, valid_from/valid_to gate, web-UI-first export).
3. `test/skills-installers.test.ts` (extend `installers.test.ts`, `install-copy.test.ts`) — 5-client × 9-skill matrix, per-env URLs, idempotent rerun, cleanup only touches managed entries.
4. `test/skills-db.test.ts` (pg-mem/testcontainers) — submit→pending invisible publicly; non-admin list/review → 403; approve→released visible; reject→note; restart→intact; dup `(slug,env)` blocked.
5. `test/skills-usage-prompt.test.ts` — fires at threshold, ignores 1-offs, redacts ids/paths, decline leaves no files.
6. Update `server-instructions.test.ts`, `tool-instructions.test.ts` — skill names referenced exist, no orphans.

Gate: `npx tsc --noEmit && pnpm test && pnpm check:tool-fields && pnpm check:skills`.

## 5. Implementation Order

1. Generator + 9 skills + parity tests.
2. DB schema + config + `tdei_submit_skill` / list / review + DB tests.
3. Gateway catalogue + per-client installers + status page + installer matrix tests.
4. Usage-chain detector + in-chat draft + local save + prompt tests.
5. Docs (`README` skills section), `tdei.config` + `mcps.schema` wiring, deploy notes.

## 6. Integration Points

- `src/server.ts`, `http-semantic-server.ts`: register 3 skill tools (core profile only, like `tdei_*`).
- `src/tdei-shared/install-copy.ts`: skill copy blocks.
- `src/init/`, `src/setup.ts`: `--with-skills`, `--skills-dir`, `submit-skill` command.
- `src/http-setup-script.ts`, `http-status-page.ts`: skills catalogue + installers.
- No changes to dataset upload/download byte path (hands-free curl unchanged).

## 7. Risks

- DB required to boot gateway → mitigate with clear fail-fast + `setup --check-db`.
- Skill spam → rate-limit submits per author/day + dedupe on chain hash.
- Namespace collisions → reserved `tdei-*`, user prefix enforced server-side.

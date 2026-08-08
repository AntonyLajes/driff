# AGENTS.md

## Project overview

Internal tool that automatically generates release notes and PR documentation for mobile teams. Listens to GitHub events (merged PRs, Xcode version bumps), generates summaries with an LLM, and publishes them to Notion. Runs as an HTTP service that receives webhooks and processes jobs asynchronously.

The product is being dogfooded inside a US-based mobile startup, with the goal of eventually being commercialized as a SaaS for mobile-first engineering teams.

**Required stack:**
- Node.js 20+ with TypeScript
- Postgres (Railway)
- Hosting: Railway

**Chosen stack (with rationale):**
- HTTP framework: **Fastify** — faster than Express, native TypeScript support, mature plugin ecosystem.
- ORM: **Drizzle** — type-safe without heavy code generation, SQL-like API, simple migrations. Prisma is a valid alternative but more "magical".
- Validation: **Zod** — schemas double as TypeScript types.
- GitHub: **Octokit** (`@octokit/rest` + `@octokit/webhooks`) — official library.
- LLM: **`@anthropic-ai/sdk`** with Claude Sonnet — best quality for long summaries.
- Notion: **`@notionhq/client`** — official SDK.
- Queue: **Postgres table** with `SELECT ... FOR UPDATE SKIP LOCKED` — no Redis in MVP.
- Logger: **Pino** — fast, structured JSON, integrates with Fastify.
- Config: **dotenv** + Zod to validate env vars at boot.

---

## Current architecture (as of 2026-06-03) — READ THIS FIRST

The phased "Phase 1…8" sections further down are the **original build plan** and are partly historical. Where they conflict with this section, **this section wins**. Key facts about how the system actually works today:

**Three summary pipelines, all live and validated end-to-end:**
- `process_pr` — merged PR → AI summary → destinations. Base-branch filter via `workspace_settings.pr_summary_base_branches` (empty/null = any base).
- `process_release` — push to the configured release branch that touches the version file (iOS plist/pbxproj or Expo `app.json`) → AI changelog → destinations. Config: `release_project_kind` + `release_version_file_path` (+ `release_version_branch`).
- `process_push` — direct push to a configured branch → AI summary → destinations. Config: `workspace_settings.push_summary_branches`. **Gotcha:** when empty, `buildPushConfig` returns `null` and **no push job is ever enqueued** (it does NOT fall back to the default branch at that layer). **Overlap dedup (implemented):** a push that is really a PR merge or a release version bump is skipped in `process_push` (no duplicate push summary) — see `src/jobs/push-dedup.ts`. Detection is race-free via the sibling `jobs` rows: skip if a `process_release` job shares the push's `afterSha`, or if every PR number the push references (from merge/squash commit messages) has a `process_pr` job. Requiring *all* referenced PRs to be covered fails safe — a push mixing PR merges with un-summarized direct commits is still published.

**Provider-agnostic workspaces (not GitHub-specific anymore):** `workspaces.sourceProvider` ('github'|'gitlab'|'bitbucket') + `repoFullName` + `repoDefaultBranch` (renamed from the old `github_*` columns). Unique `(sourceProvider, repoFullName)` = 1 repo → 1 workspace globally. Per-user OAuth tokens live in `user_source_connections` (provider-keyed). Source layer is abstracted behind `src/sources/registry.ts` (`getSource`); only GitHub is implemented.

**Pluggable, multi-tenant output destinations** (mirror of the source registry): `src/destinations/registry.ts` (`getDestination`; only `notion` implemented — slack/whatsapp throw). `composite-destination.ts` fans one publish out to all enabled destinations with **per-destination error isolation**. New table `workspace_destinations` (one row per `(workspaceId, type)`, `config` jsonb + sealed `secret_ciphertext`). **Notion is OAuth multi-tenant** — the bot token is sealed per workspace (decrypted with `AUTH_JWT_SECRET`); the global `NOTION_TOKEN` env is **deprecated/optional**. The Notion DB-id columns were dropped from `workspace_settings` (migration 0012); they now live in the destination's `config` (`prDatabaseId`/`releasesDatabaseId`/`pushesDatabaseId`).

**Notion auto-provisions its schema** (`src/destinations/notion/notion-schema.ts`): before each publish it resolves the database's data source (Notion-Version 2025-09-03 moved the property schema onto data sources), diffs existing properties against a per-summary spec, and adds missing ones via `dataSources.update`. The specs MUST stay in sync with the `toProperties`/`toReleaseProperties`/`toPushProperties` page payloads.

**Worker resilience (learned the hard way):** the worker (`src/queue/worker.ts`) runs in the same process as the HTTP server (started in `index.ts`). The poll loop **must** wrap `runOnce()` in try/catch and keep polling after a backoff — a single transient error (e.g. a dropped Postgres connection during an idle dequeue) escaping `run()` once left the worker permanently dead **with zero logs** while the server stayed healthy (jobs piled up `pending`, `attempts=0`). It now logs lifecycle + per-job outcomes via an injectable `WorkerLogger` (defaults to console). **Do not** reintroduce a silent `.catch(() => undefined)` around `worker.run()`. **Queue health is exposed at `GET /health/queue`** (`src/queue/queue-health.ts`): returns 200 `ok` / 503 `degraded` with checks for stale pending jobs (worker not consuming), failed jobs in the last 24h, and stuck `running` jobs. Point an external uptime monitor at it — that's the alerting layer (no push/Slack alert yet).

**Usage metering (no enforcement yet):** each successful summarization records token usage in `llm_usage` (`repo`, `job_type`, `model`, `input/output_tokens`) — the summarizers return `usage` (from the Anthropic response) and the jobs call `recordLlmUsage` (best-effort: never fails the job). This feeds future usage-based pricing/tiers (deferred to a pre-prod decision — see the billing-tiers note). The other tier dimensions already exist: projects = `workspaces`, outputs = `workspace_destinations`.

**Driff Lab (V1 P0):** deterministic GitHub scenarios live in `src/lab/fixtures/` and are validated by `src/lab/scenario.ts`. Run `npm run lab:validate -- <scenario.json>` for a side-effect-free contract check. Run `npm run lab:verify -- <scenario.json>` to pass signed events through an in-memory Fastify server using the real webhook handler and assert each event's `expectedJobs`, without network or DB access. Run `npm run lab:replay -- <scenario.json> [target-url] [--run-id=<id>]` to send the same HMAC-signed events sequentially through a running `/webhooks/github` boundary. Omit `--run-id` to test delivery idempotency; provide a kebab-case run ID to derive fresh delivery IDs without destructive database resets. Localhost is allowed by default. A remote target requires both `--confirm-development` and its exact hostname in the CLI-only `DRIFF_LAB_ALLOWED_HOSTS` comma-separated allowlist; never add a production hostname or a production bypass route. Scenarios use schema version `1`, one repository, explicit webhook settings, ordered offsets, unique delivery IDs, raw GitHub payloads, and expected job types. Payload repository names must match the scenario repository. Replay uses `GITHUB_WEBHOOK_SECRET` and never prints it.

**Canonical V1 change graph (additive foundation):** migration 0018 adds `project_versions`, `changes`, `change_evidence`, `product_areas`, `change_areas`, and `change_contributors`; migration 0019 adds the indexed nullable `project_versions.source_release_id` FK so every projected version can navigate back to its legacy release row. These tables are the future read model for the version timeline and Ask Driff: a version groups user-understandable changes; every change can retain claim-level evidence, product-area links, and collaboration roles. Existing `pull_requests`, `pushes`, and `releases` remain the source records and current production paths. Introduce projections with idempotent dual writes, backfill and compare them against the legacy outputs before switching any API/UI reads; do not remove or bypass the legacy tables during that transition. `src/changes/project-pull-request.ts` is the first projector: it derives stable UUIDs from workspace + source identity so retries converge, writes the change/evidence/area/contributor set in one transaction, and intentionally leaves `version_id` untouched until release lineage is known. The runtime `process_pr` handler enables it through the `canonicalProjection` dependency immediately after the legacy upsert returns its source-record ID; callers that omit this dependency retain the legacy-only behavior for isolated tests/tools. Preserve workspace isolation on every query and never derive individual productivity scores from contributor rows. Semantic embeddings/search are deliberately deferred until deterministic relational retrieval is working and measured.

**Webhook gating** is decoupled from Notion: release notes run when a release version source + branch are configured; push summaries when `push_summary_branches` is non-empty; PR summaries whenever a workspace + destination exist. All runtime resolution is strict by `(sourceProvider, repoFullName)` with no env fallback.

---

## Agent operating rules

These rules apply to any AI agent (Claude, Copilot, Cursor, etc.) working on this codebase.

### Phase reporting (mandatory)

Every response that involves changing code, creating files, or proposing implementation **must start with a header indicating which phase the work belongs to**. Format:

```
**Phase: <number> — <phase name>**
**Scope: <short description of what's being touched>**
```

Example:
```
**Phase: 1 — Core PR ingestion**
**Scope: Implementing the GitHub webhook handler and signature verification**
```

If a change spans multiple phases, list them all and explain why. If a change does not belong to any defined phase, flag it explicitly and ask for confirmation before proceeding — this prevents scope creep into undefined territory.

### Commit conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit message must follow:

```
<type>(<scope>): <short description>

[optional body]

[optional footer]
```

**Allowed types:**
- `feat` — new feature for the user / new capability of the system.
- `fix` — bug fix.
- `refactor` — code change that neither fixes a bug nor adds a feature.
- `chore` — build, tooling, deps, config changes (no production code change).
- `docs` — documentation only.
- `test` — adding or fixing tests.
- `perf` — performance improvement.
- `style` — formatting, whitespace, etc. (no code change).
- `ci` — CI/CD changes.
- `revert` — reverts a previous commit.

**Scope** is optional but encouraged. Use the module name (`webhooks`, `notion`, `llm`, `db`, `queue`, etc.).

**Examples:**
```
feat(webhooks): add GitHub signature verification
fix(notion): handle markdown headings longer than 2000 chars
refactor(queue): extract retry logic into separate function
chore(deps): bump @anthropic-ai/sdk to latest
docs(agents): add phase 4 specification
```

**Rules:**
- Description in lowercase, imperative mood ("add" not "added"), no period at the end.
- Keep the subject line under 72 chars.
- Use the body to explain *why*, not *what* (the diff shows what).
- Breaking changes get a `!` after the type/scope and a `BREAKING CHANGE:` footer.

### Commit granularity (mandatory)

- **Create separate commits for separate implementations.**
- One logical change per commit. Do not mix feature logic, refactors, tests, docs, and tooling updates in the same commit unless they are inseparable.
- For each production logic change, include a dedicated `test(...)` commit in the same PR whenever possible.
- Keep commits reviewable and reversible: small, focused, and with a clear intent.

### Scope drift governance (mandatory)

- If a new implementation, tool, dependency, infra component, or workflow is introduced and it is **not explicitly documented** in this file, update `AGENTS.md` in the same workstream.
- The `AGENTS.md` update must include:
  - what was added;
  - why it was added;
  - how it should be used (commands, constraints, or conventions).
- Do not defer documentation updates to "later". New behavior without updated agent guidance is considered incomplete work.

### General coding rules

- **TypeScript strict mode**, with `noUncheckedIndexedAccess: true`.
- **No `any`**. Use `unknown` + narrowing when the type is genuinely unknown.
- **Always validate external input with Zod** — webhook payloads, LLM responses, env vars, third-party API responses.
- **Errors are `Error` objects with clear messages**, never strings. Use `cause` to chain underlying errors.
- **Structured logs via Pino**, never `console.log` in production code.
- **Pure functions when possible**. Concentrate side effects in outer layers (HTTP, DB, integrations).
- **Absolute imports** via the `@/` path alias pointing to `src/`.
- **File names in kebab-case** — always. `github-source.ts`, not `GitHubSource.ts` or `githubSource.ts`. This applies to every file in the project, including TypeScript modules, prompts, configs, and docs. Exported symbols inside the file keep their natural casing (PascalCase for classes/types, camelCase for functions/variables) — only the file name itself is kebab-case.
- **Use SOLID principles** as design defaults (especially single responsibility and dependency inversion).
- **Each logic file must expose a single primary entrypoint function named `execute` or `handler`** (pick the name that best matches the context and keep consistency inside the module).
- **Keep transport/framework code thin** and delegate business logic to dedicated modules.
- **Prefer constructor/function dependency injection** to keep modules testable and avoid hidden global coupling.
- **Do not add new logic without unit tests** in the same implementation stream.
- **Don't add features that aren't in the current phase** without flagging it first.

### Testing standards (mandatory)

- Testing framework is **Vitest** (`vitest` + `@vitest/coverage-v8`).
- Every logic module must have a corresponding unit test file (`*.test.ts`) covering success path, relevant edge cases, and failure path.
- Use clear test names in behavioral style: `should <expected behavior> when <condition>`.
- Mock external side effects (GitHub, Notion, DB, LLM, HTTP) and keep unit tests deterministic.
- Coverage targets:
  - lines: **90%**
  - functions: **90%**
  - statements: **90%**
  - branches: **84%** (entry `src/index.ts` is excluded from coverage; integration wiring is covered indirectly)
- Minimum quality gate before merge:
  - `npm run typecheck`
  - `npm run test`
  - `npm run test:coverage`

---

## Directory structure

```
docs/
  release-compare-windows.md  # Spec: Git compare windows for build vs marketing-version releases
src/
  changes/
    canonical-id.ts        # Stable IDs shared by idempotent graph projectors
    project-pull-request.ts # Idempotent PR → canonical graph projection
  config/
    env.ts                  # Env var validation with Zod (secrets + infra)
    workspace-settings.ts   # Resolve strict per-workspace settings (no global fallback)
    release-project-kind.ts # Tipo de projeto + path único → campos legados plist/pbx/expo
  db/
    schema.ts               # Drizzle schemas
    client.ts               # Postgres + Drizzle client
    migrations/             # Generated migrations
  http/
    server.ts               # Fastify setup
    cors.ts                 # Optional @fastify/cors (reflect in dev, allowlist when CORS_ORIGINS set)
    routes/
      webhooks.ts           # POST /webhooks/github
      webhook-release.ts   # push → process_release gating
      health.ts             # GET /health
  lib/
    plist-version.ts        # CFBundle* from XML plist
    expo-app-config-version.ts # Expo app.json / static app.config.js|ts → marketing + build
  sources/
    source.ts               # Source interface (origin abstraction)
    github/
      github-installation.ts# GitHub App install token for a repo
      github-source.ts      # PR fetch
      gather-release-context.ts # Compare + plist for releases
      verify.ts             # HMAC signature verification
      types.ts              # Relevant event types
  destinations/
    destination.ts          # Destination interface
    notion/
      notion-destination.ts # Notion implementation
      blocks.ts             # PR page blocks
      release-blocks.ts     # Release page blocks
  llm/
    summarizer.ts           # PR summaries
    release-summarizer.ts   # Release notes JSON from Claude
    prompts/
      pr-summary.md
      release-changelog.md
  queue/
    queue.ts                # Enqueue/dequeue via Postgres
    worker.ts               # Worker loop
  jobs/
    process-pr.ts
    process-release.ts      # iOS version delta → Notion
  index.ts                  # Entry point: HTTP server + worker
drizzle.config.ts
package.json
tsconfig.json
.env.example
README.md
docker-compose.yml
```

---

## Commands

```bash
# Initial setup
npm install
cp .env.example .env       # Fill in values

# Development
npm run dev                # Runs src/index.ts with tsx --watch
npm run db:generate        # Generates migration from schema
npm run db:migrate         # Applies migrations to the DB
npm run db:studio          # Drizzle UI for inspecting data

# Local infrastructure (Docker)
npm run docker:up          # Starts local services (Postgres + Adminer)
npm run docker:down        # Stops local services
npm run docker:ps          # Shows running local services
npm run docker:logs        # Follows local services logs

# Build / production
npm run build              # tsc → dist/
npm start                  # node dist/index.js

# Quality
npm run typecheck          # tsc --noEmit
npm run test               # Runs unit tests with Vitest
npm run test:watch         # Runs Vitest in watch mode
npm run test:coverage      # Runs tests with coverage thresholds
npm run lint               # eslint
npm run format             # prettier --write
```

---

## Environment variables

Validated in `src/config/env.ts` with Zod. **Secrets and infra** (database URL, GitHub App, webhook secret, Anthropic, Notion token, port/log level) stay here. **Workspace behavior/configuration** (Notion database IDs, PR base branches, release branch, release version file/kind, repo filters) must live in `workspace_settings` and is resolved per repository.

```
# Postgres (Railway provides automatically when you attach the DB)
DATABASE_URL=postgres://...

# GitHub App
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=    # Contents of the .pem, with \n preserved
GITHUB_WEBHOOK_SECRET=     # Secret defined when creating the app

# Anthropic
ANTHROPIC_API_KEY=

# Notion — DEPRECATED global token. Per-workspace Notion auth is now OAuth, sealed in
# `workspace_destinations` (see "Current architecture"). Kept optional for back-compat only.
NOTION_TOKEN=
# Notion public OAuth integration (required for the multi-tenant connect flow)
NOTION_OAUTH_CLIENT_ID=
NOTION_OAUTH_CLIENT_SECRET=

# App
PORT=3000
LOG_LEVEL=info
NODE_ENV=development
# CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

### CORS (Driff web UI → API)

Browsers call the JSON API from a different origin than Fastify (e.g. Vite on port 5173). **`CORS_ORIGINS`** is an optional comma-separated allowlist. When it is **empty**: `NODE_ENV === "development"` registers **reflective** CORS (`Access-Control-Allow-Origin` mirrors the request `Origin`); `test` and `production` leave CORS **off** until you set explicit origins. When **`CORS_ORIGINS` is non-empty**, that allowlist is always used (all environments). Registration lives in `src/http/cors.ts` and is wired from `src/index.ts` into `createServer`. Preflight responses explicitly allow **`DELETE`**, **`PATCH`**, and **`PUT`** (not only GET/POST), so browser calls such as GitHub disconnect succeed.

### `workspaces` (Postgres)

Users (`users`) can own multiple **workspaces** (display `name` + URL-safe `slug` unique per user). Optional **`workspace_kind`** stores the app type for onboarding (`ios_plist`, `ios_pbx`, `react_native_expo`, `android_gradle`, `flutter_pubspec` — same vocabulary as release config).

When **Google OAuth** is fully configured, the HTTP server exposes **`GET /api/me/workspaces`** and **`POST /api/me/workspaces`** with **`Authorization: Bearer <session JWT>`**. `POST` JSON: `{ "name": string, "slug"?: string, "workspaceKind"?: string }` — omit `slug` to derive it from `name`. Duplicate slug for the same user returns **409**.

**`PATCH /api/me/workspaces/:workspaceId`** (same Bearer auth): partial JSON body — any of `name`, `workspaceKind` (`null` clears), `githubRepoFullName` (`owner/repo` or `null`), `githubRepoDefaultBranch` (`null` clears). Only workspaces owned by the session user can be updated (**404** otherwise).

### GitHub user OAuth (workspace onboarding)

This is **not** the same integration as the **GitHub App** (`GITHUB_APP_*`) used for webhooks and installation tokens. For onboarding you create a separate **GitHub OAuth App** (user-to-server) so operators can list repositories and run lightweight file detection.

**Dashboard checklist (github.com):**

1. Go to **Settings → Developer settings → OAuth Apps → New OAuth App** (or use an existing OAuth App dedicated to Driff).
2. **Application name:** e.g. `Driff (local)` / `Driff`.
3. **Homepage URL:** your product URL (e.g. `http://localhost:5173` in dev).
4. **Authorization callback URL** — must match the API exactly (no trailing slash on the origin you set in `AUTH_PUBLIC_URL`):
   - `{AUTH_PUBLIC_URL}/api/me/github/oauth/callback`
   - Example: `http://localhost:3000/api/me/github/oauth/callback`
5. After creation, copy **Client ID** → `GITHUB_USER_OAUTH_CLIENT_ID`, generate a **Client secret** → `GITHUB_USER_OAUTH_CLIENT_SECRET`.
6. Put both variables in the back-end `.env` together with the same **Google OAuth bundle** you already use for session JWTs: `AUTH_JWT_SECRET`, `AUTH_PUBLIC_URL`, `FRONTEND_URL`. If either GitHub client variable is missing while the other is set, boot fails (Zod).

**Runtime routes (registered when the GitHub user OAuth env pair + JWT bundle are all set):**

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/me/github/oauth/start` | Bearer session JWT | Returns JSON `{ "authorizeUrl" }` — open this URL in the browser to start GitHub OAuth. |
| `GET` | `/api/me/github/oauth/callback` | _(GitHub redirect)_ | Exchanges `code`, stores sealed tokens in `user_github_accounts`, redirects to **`FRONTEND_URL/workspaces/new/github?github_oauth=success&github_login=...`** (or `github_oauth=exchange_failed`, etc.). |
| `GET` | `/api/me/github/status` | Bearer | `{ "connected": boolean, "githubLogin"?: string }` |
| `DELETE` | `/api/me/github/disconnect` | Bearer | **204** — removes stored GitHub tokens for the user. |
| `GET` | `/api/me/github/repos` | Bearer | Query `page` (default 1), `per_page` (default 30, max 100). Returns `{ repos, page, perPage, hasMore }`. **400** `github_not_connected` if OAuth not completed. |
| `POST` | `/api/me/github/repo/infer` | Bearer | JSON `{ "fullName": "owner/repo" }` → `{ "inference": { suggestedKind, confidence, defaultBranch, versionFilePath, signals } }`. Uses the user’s GitHub token and the Contents API only (no clone). |

**Scopes requested:** `read:user repo` (see `GITHUB_OAUTH_SCOPES` in `src/http/routes/github-me.ts`). Adjust there if you need a narrower scope later.

**Secrets:** access (and optional refresh) tokens are sealed with **AES-256-GCM** using a key derived from `AUTH_JWT_SECRET` (`src/auth/token-aes.ts`). Treat `AUTH_JWT_SECRET` as a sensitive root key.

### `workspace_settings` (Postgres)

A workspace MAY have a row in `workspace_settings` via `workspace_id` (1:1 by unique index); it holds INPUT config only (release source, PR/push branch filters) — the Notion DB-id columns were dropped in migration 0012. A workspace with no settings row still resolves (PR summaries work with just a destination). Runtime webhook + worker resolution is strict by `(workspaces.sourceProvider, workspaces.repoFullName)` (renamed from the old `github_*` columns) and **does not** fall back to global/env behavior settings. Output destinations are loaded separately from `workspace_destinations`.

After `npm run db:migrate`, create/update settings for each workspace id. Example:

```sql
INSERT INTO workspace_settings (
  workspace_id,
  notion_pr_database_id,
  notion_releases_database_id,
  release_project_kind,
  release_version_file_path,
  release_version_branch,
  pr_summary_base_branches
) VALUES (
  'workspace-uuid-here',
  'your-notion-pr-database-id',
  'your-notion-releases-database-id',
  'ios_plist',
  'ios/App/Info.plist',
  'main',
  '["main"]'::jsonb
);
```

**Preferido (onboarding / “adicionar projeto”):** `release_project_kind` + `release_version_file_path` (sempre os dois). Valores de `release_project_kind`: `ios_plist` (Info.plist), `ios_pbx` (`project.pbxproj`), `react_native_expo` (`app.json` / `app.config.*`). Reservados (ainda sem parser): `android_gradle`, `flutter_pubspec`. O merge em `workspace-settings.ts` mapeia isto para os campos internos usados por `gather-release-context`.

**Legado:** ainda podes preencher só `release_info_plist_path`, `release_project_pbxproj_path`, ou `release_expo_app_config_path` (ou envs equivalentes); o boot infere `release_project_kind` + `release_version_file_path` para UI.

Validation: `notion_pr_database_id` must be set in the workspace row. If `notion_releases_database_id` is set, `release_version_branch` must be set, and **at least one** fonte de versão: o par unificado (`release_project_kind` + `release_version_file_path`) **ou** qualquer um dos três caminhos legados.

**Expo / React Native:** Com `react_native_expo` + path, `gather-release-context` lê `expo.version` e build a partir desse ficheiro (JSON fiável; `.js`/`.ts` usa extração estática por regex — preferir `app.json`/`app.config.json` quando o config é dinâmico). Webhooks `push` observam `versionWatchPaths` derivados desses caminhos.

---

## Roadmap (phases)

The project is divided into phases. Each phase is a coherent, shippable unit of scope. Phases build on each other but each one delivers value on its own — so the project is always "done" at any phase boundary.

| Phase | Name                            | Status      |
|-------|---------------------------------|-------------|
| 1     | Core PR ingestion               | Completed   |
| 2     | Version bump detection          | Completed   |
| —     | Push summaries (`process_push`) | Completed (added after the original plan) |
| 3     | Slack digest                    | Planned (destination seam exists; `slack` not implemented) |
| 4     | Multi-PR thematic threads       | Planned     |
| 5     | Multi-repo + multi-tenancy      | Completed (provider-agnostic workspaces; 1 repo → 1 workspace) |
| 6     | Additional sources/destinations | Partial (pluggable registries done; only GitHub source + Notion destination implemented) |
| 7     | Cost optimization & scaling     | Planned (no per-workspace cost guardrails yet) |
| 8     | Public dashboard & onboarding   | Partial (operator UI + onboarding exist; no public dashboard) |

---

## Phase 1 — Core PR ingestion

**Goal:** When a PR is merged in the configured iOS repo, within ~30 seconds a Notion page should appear with the PR title, author, category, area, and two summaries (user-facing and technical) generated by the LLM.

**Done criteria:** 5 consecutive real PRs flow end-to-end without manual intervention.

### Data model (Drizzle schema)

Schemas in `src/db/schema.ts`. Four tables in Phase 1:

#### `webhook_events`
Raw log of ALL received webhooks. Idempotency + debugging.
- `id` (uuid, PK)
- `delivery_id` (text, UNIQUE — header `X-GitHub-Delivery`)
- `event_type` (text — `pull_request`, `push`, etc)
- `payload` (jsonb — full payload)
- `received_at` (timestamp default now)
- `processed_at` (timestamp nullable)

#### `pull_requests`
Processed PRs.
- `id` (uuid, PK)
- `repo` (text — `owner/name`)
- `pr_number` (int)
- `title` (text)
- `author` (text)
- `merged_at` (timestamp)
- `head_sha` (text)
- `base_branch` (text)
- `summary_user_facing` (text nullable)
- `summary_technical` (text nullable)
- `category` (text nullable — feature, bugfix, refactor, chore, other)
- `area` (text nullable — login, checkout, etc)
- `notion_page_id` (text nullable)
- `prompt_version` (int nullable — which prompt version generated this)
- `created_at`, `updated_at`
- UNIQUE(`repo`, `pr_number`)

#### `jobs`
Processing queue.
- `id` (uuid, PK)
- `type` (text — `process_pr` in Phase 1)
- `payload` (jsonb)
- `status` (text — `pending`, `running`, `done`, `failed`)
- `attempts` (int default 0)
- `last_error` (text nullable)
- `available_at` (timestamp default now — for retry with backoff)
- `created_at`, `updated_at`
- INDEX on (`status`, `available_at`)

#### `prompts`
Prompt versioning (loaded from file, but history kept in DB).
- `id` (uuid, PK)
- `name` (text — e.g. `pr-summary`)
- `version` (int)
- `content` (text)
- `created_at`
- UNIQUE(`name`, `version`)

> Load the prompt from file at boot, compare with the latest version in the DB, insert a new version if it changed. Save `prompt_version` on each processed PR for traceability.

### Abstraction interfaces

Important to implement from Phase 1 even with a single concrete implementation — Phase 6 will add more.

#### `src/sources/source.ts`
```typescript
export interface PullRequestEvent {
  repo: string;
  prNumber: number;
  title: string;
  body: string | null;
  author: string;
  mergedAt: Date;
  headSha: string;
  baseBranch: string;
  diff: string;        // full diff (mind the size)
  files: Array<{ path: string; additions: number; deletions: number }>;
}

export interface Source {
  fetchPullRequest(repo: string, prNumber: number): Promise<PullRequestEvent>;
}
```

#### `src/destinations/destination.ts`
```typescript
export interface PRSummary {
  repo: string;
  prNumber: number;
  title: string;
  author: string;
  mergedAt: Date;
  summaryUserFacing: string;
  summaryTechnical: string;
  category: 'feature' | 'bugfix' | 'refactor' | 'chore' | 'other';
  area: string | null;
  prUrl: string;
}

export interface Destination {
  publishPR(summary: PRSummary): Promise<{ pageId: string }>;
}
```

### Phase 1 flow

```
GitHub webhook (pull_request closed + merged)
  ↓
POST /webhooks/github
  ↓ (verify HMAC signature, check duplicate delivery_id)
Insert into webhook_events + insert job into jobs (type=process_pr)
  ↓ (return 200 immediately)
  
Worker (loop)
  ↓
SELECT pending job FOR UPDATE SKIP LOCKED
  ↓
GitHubSource.fetchPullRequest()  → diff + metadata
  ↓
summarizer.summarizePR()  → structured JSON via Claude
  ↓
upsert into pull_requests
  ↓
NotionDestination.publishPR()  → create/update page
  ↓
Mark job as done
```

### Implementation steps

#### 1. Initial setup (~30min)
- `npm init -y` and `npm install` deps:
  - prod: `fastify`, `@fastify/sensible`, `pino`, `pino-pretty`, `dotenv`, `zod`, `drizzle-orm`, `postgres`, `@octokit/rest`, `@octokit/webhooks`, `@anthropic-ai/sdk`, `@notionhq/client`, `uuid`
  - dev: `typescript`, `tsx`, `@types/node`, `@types/uuid`, `drizzle-kit`, `eslint`, `prettier`, `vitest`, `@vitest/coverage-v8`
- `tsconfig.json` with `strict: true`, target ES2022, module NodeNext.
- `drizzle.config.ts` pointing to `src/db/schema.ts`.
- `.env.example` with all the vars listed above.

Suggested commit: `chore: initial project setup with typescript and core deps`

#### 2. Config + DB (~30min)
- `src/config/env.ts`: Zod schema parsing `process.env`. Exports typed `env`.
- `src/db/schema.ts`: the 4 tables described above.
- `src/db/client.ts`: creates `postgres()` client + `drizzle()`.
- Run `npm run db:generate` and `npm run db:migrate`.

Suggested commits:
- `feat(config): add env var validation with zod`
- `feat(db): add initial schema for webhook events, prs, jobs and prompts`

#### 3. HTTP server (~20min)
- `src/http/server.ts`: instantiate Fastify with Pino, register routes.
- `src/http/routes/health.ts`: `GET /health` returning `{ ok: true }`.
- `src/index.ts`: imports `server`, calls `server.listen({ port, host: '0.0.0.0' })`.
- Test locally: `npm run dev` then `curl localhost:3000/health`.

Suggested commit: `feat(http): bootstrap fastify server with health endpoint`

#### 4. GitHub App + webhook handler (~1h)
- Create GitHub App at github.com/settings/apps/new:
  - Webhook URL: use `https://smee.io/...` for local dev, swap to Railway later.
  - Webhook secret: generate a random one, copy to `.env`.
  - Permissions: Repository → Contents (read), Pull requests (read), Metadata (read).
  - Subscribe to events: Pull request, Push.
  - Generate private key, save the `.pem`, paste contents into `GITHUB_APP_PRIVATE_KEY` (preserve `\n`).
- Install the app on the test iOS repo.
- `src/sources/github/verify.ts`: validates `X-Hub-Signature-256` against `GITHUB_WEBHOOK_SECRET` (HMAC SHA-256).
- `src/http/routes/webhooks.ts`: `POST /webhooks/github`
  - Verify signature → 401 on failure.
  - Read `X-GitHub-Delivery` → if already in `webhook_events`, return 200 (idempotency).
  - Insert into `webhook_events`.
  - If event is `pull_request` with `action: closed` and `pull_request.merged: true`, insert `process_pr` job with payload `{ repo, prNumber }`.
  - Always return 200 unless infrastructure fails (then 500).

Suggested commits:
- `feat(webhooks): add github signature verification`
- `feat(webhooks): handle pull_request merged events and enqueue jobs`

#### 5. Source: GitHub (~45min)
- `src/sources/github/github-source.ts`: implements `Source`.
- Authenticate as GitHub App: generate JWT with `appId` + `privateKey`, exchange for installation token, create authenticated Octokit.
- `fetchPullRequest(repo, prNumber)`:
  - `pulls.get` → metadata.
  - `pulls.listFiles` → changed files.
  - `pulls.get` with `Accept: application/vnd.github.v3.diff` → full diff.
  - **Size limit**: if diff > 200KB, truncate and flag in metadata. Smarter chunking is a future phase.

Suggested commit: `feat(sources): add github source with pr fetching`

#### 6. LLM: summarizer (~1h)
- `src/llm/prompts/pr-summary.md`: versioned prompt. Suggested structure:
  ```
  You are an assistant that generates pull request summaries for a mobile engineering team.
  
  Input: PR title, description, list of changed files, and diff.
  
  Return ONLY a valid JSON object with this shape:
  {
    "title": "...",                    // 1 line, changelog style
    "summaryUserFacing": "...",        // 1-3 sentences about user impact. If none, return "No direct user-facing impact."
    "summaryTechnical": "...",         // 1-3 technical sentences
    "category": "feature|bugfix|refactor|chore|other",
    "area": "..."                      // inferred product area (e.g. login, checkout). May be null.
  }
  
  DO NOT invent user impact for refactors or chores. Be concise.
  ```
- `src/llm/summarizer.ts`:
  - Loads prompt from file at boot.
  - `summarizePR(input)`: builds message with prompt + PR data, calls Claude Sonnet, parses JSON response with Zod.
  - On invalid JSON, retry once. If it fails again, throw (job becomes failed).

Suggested commits:
- `feat(llm): add pr-summary prompt and summarizer`
- `feat(llm): add zod validation for llm responses with retry`

#### 7. Destination: Notion (~1h)
- Create a Notion database with properties:
  - `Title` (title) — PR title
  - `Repo` (text)
  - `PR Number` (number)
  - `Author` (text)
  - `Merged At` (date)
  - `Category` (select)
  - `Area` (text)
  - `URL` (url)
- Share the database with the Notion integration.
- `src/destinations/notion/notion-destination.ts`:
  - `publishPR(summary)`:
    - `pages.create` in the database, with the properties above and children blocks containing:
      - Heading "User-facing" + paragraph with `summaryUserFacing`
      - Heading "Technical" + paragraph with `summaryTechnical`
    - Return `pageId`.

Suggested commit: `feat(notion): add notion destination with pr page creation`

#### 8. Queue + worker (~45min)
- `src/queue/queue.ts`:
  - `enqueue(type, payload, opts?)`: insert into `jobs`.
  - `dequeue()`: `UPDATE jobs SET status='running' WHERE id = (SELECT id FROM jobs WHERE status='pending' AND available_at <= now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`.
  - `markDone(id)` / `markFailed(id, error)`.
- `src/queue/worker.ts`:
  - Infinite loop: try `dequeue()`. If empty, sleep 2s. If a job comes back, dispatch to handler in `src/jobs/`.
  - Global try/catch: error → `markFailed`, increment `attempts`. If `attempts < 3`, reschedule with `available_at = now() + 1min * 2^attempts`. Otherwise, permanent failure.
- `src/jobs/process-pr.ts`:
  - Receives `{ repo, prNumber }`.
  - Calls `GitHubSource.fetchPullRequest`.
  - Calls `summarizer.summarizePR`.
  - Upserts into `pull_requests`.
  - Calls `NotionDestination.publishPR`.
  - Updates `pull_requests.notion_page_id`.

Suggested commits:
- `feat(queue): add postgres-backed job queue with skip-locked dequeue`
- `feat(queue): add worker loop with exponential backoff retry`
- `feat(jobs): add process-pr job handler`

#### 9. Wire it all together (~30min)
- `src/index.ts`:
  - Loads env, connects DB.
  - Starts HTTP server.
  - Starts worker in parallel (same process in MVP — split into separate process only when scaling demands it).
  - Graceful shutdown on SIGTERM.

Suggested commit: `feat: wire http server and worker into single entry point`

#### 10. Deploy to Railway (~30min)
- `railway init` in the project.
- Attach Postgres add-on → sets `DATABASE_URL` automatically.
- Add other env vars in the panel.
- `railway.json` or `Procfile` if needed (Railway auto-detects `npm start`).
- Update GitHub App webhook URL → Railway's public URL.
- Push, deploy, merge a test PR, verify the page is created in Notion.

Suggested commit: `chore(deploy): add railway configuration`

### What NOT to do in Phase 1

- Do not support multiple repos (hardcode yours via env var).
- Do not build any UI/dashboard.
- Do not optimize LLM cost (send everything to Sonnet, optimize later).
- Do not handle huge PRs with sophisticated chunking (just truncate).
- Do not implement fancy retry strategies (3 attempts with simple backoff).
- Do not think about multi-tenancy.
- Do not handle PR updates (Phase 1 is "PR merged → page created"; updates later).
- Version bumps are handled in Phase 2 (push → `process_release`); tags remain a CI concern.
- Do not send Slack notifications (Phase 3).

---

## Phase 2 — Version bump detection (implemented)

**Goal:** When a push to the configured branch updates the app’s visible version (ficheiro definido por `release_project_kind` + `release_version_file_path`, ou caminhos legados plist / pbx / Expo), generate consolidated release notes in a **second Notion database** and persist one row per logical version in `releases`.

**Behavior:**
- GitHub `push` to `RELEASE_VERSION_BRANCH` (e.g. `develop`). Enqueue is skipped unless the push likely touched `RELEASE_INFO_PLIST_PATH`, (if set) `RELEASE_PROJECT_PBXPROJ_PATH`, or (if set) the Expo app config path — e.g. a bump that only edits `project.pbxproj` still enqueues when that path is configured. (If the batch has 20 commits — GitHub cap — the handler assumes something may have changed and the job re-checks by comparing SHAs.) Creating tags in GitHub is **out of scope** (CI); Shipnot only reads the API.
- Job `process_release`: read version sources at the push webhook’s `before` / `after` SHAs (`gather-release-context`: Expo path takes precedence over pbx, then plist). The GitHub compare range for commits/PR hints may use a **wider** left edge: build-only bumps anchor to the latest prior `releases.head_sha` for the same `repo`, `branch`, and `short_version` (fallback: optional `RELEASE_COMPARE_ROOT_SHA`, then webhook `before`); marketing bumps use the earliest stored `marketing_era_start_sha` on the old `short_version`, then the latest prior `head_sha` on that line, then the same fallbacks (`docs/release-compare-windows.md`). If `RELEASE_EXPO_APP_CONFIG_PATH` (or DB column) is set, read `expo.version` and native build fields from that file at each SHA; else if `RELEASE_PROJECT_PBXPROJ_PATH` is set, read `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` from the pbx; otherwise read the plist. If the plist only contains `$(...)` placeholders and neither pbx nor Expo path is set, the job fails with a clear config error. The GitHub compare range supplies every commit (`compareCommits`); commits that are **not** merge/squash PR lines are passed as `standaloneCommitHints` to the LLM. For each PR number found in that range, matching rows in `pull_requests` (same `repo`) enrich the input with stored `summary_user_facing` when the PR was processed earlier. The prompt `release-changelog.md` returns user-facing **changelog** copy only (no engineering appendix), stored in `releases.changelog`, with optional sectioned bullets; Notion page body shows **Changelog** + sections. Persist the effective compare base in `releases.before_sha` and the marketing-line era anchor in `releases.marketing_era_start_sha` (first row on a `short_version` sets it; later rows reuse it).
- Idempotency: `releases` has unique (`repo`, `version_key`).

**Compare windows:** Implemented per `docs/release-compare-windows.md` (`resolve-release-compare-before`, `gather-release-context` `compareBeforeSha`, optional `RELEASE_COMPARE_ROOT_SHA`, column `releases.marketing_era_start_sha`).

**Notion “Releases” database properties (must match integration):** Title, Repo, Branch, Version, Short Version, Build, Previous Version, URL, PR Numbers (see `notion-destination`).

**Out of scope:** Plist **binary** format, Android versioning **outside** Expo `expo.android.versionCode` in the configured app config, App Store Connect, creating git tags.

---

## Phase 3 — Slack digest

**Goal:** Push real-time and digest notifications to Slack so the team consumes the data without opening Notion.

**Key components to add:**
- New `Destination` implementation: `SlackDestination`.
- Per-PR notification on merge (optional, off by default — too noisy for some teams).
- Daily digest (configurable time) summarizing PRs merged in the last 24h, grouped by area.
- Weekly digest summarizing the week, including releases shipped.
- Release notification when a version bump is detected (Phase 2 hook).
- Configurable channels per notification type via env vars (later: per-team config in DB).

**Out of scope:** Interactive Slack commands, threaded discussions, two-way sync.

---

## Phase 4 — Multi-PR thematic threads

**Goal:** Detect that multiple PRs over time belong to the same theme (e.g. "onboarding redesign" spanning 4 PRs over 2 weeks) and consolidate them into a single narrative entry. This is the magic differentiator vs. existing tools.

**Key components to add:**
- New table `themes`: `id`, `name`, `description`, `started_at`, `ended_at`, `status`.
- New table `theme_prs`: many-to-many linking PRs to themes.
- Embedding-based clustering: store an embedding per PR (using a cheap model), nightly job clusters recent PRs and proposes themes.
- Heuristics: PRs touching the same file paths within a time window get clustered together as a baseline.
- LLM step: given a cluster, generate the theme name + narrative description.
- Notion: new "Themes" database with consolidated entries linking to individual PR pages.
- Manual override: ability to merge / split / rename themes via a simple admin endpoint.

**Out of scope:** Real-time theme detection (nightly batch is fine), cross-repo themes.

---

## Phase 5 — Multi-repo + multi-tenancy

**Goal:** Move from "hardcoded for one team" to "multi-org SaaS-ready". This is the precondition for commercialization.

**Key components to add:**
- New tables: `organizations`, `users`, `org_members`, `repositories`, `integrations`.
- All existing tables get an `organization_id` foreign key + indexes.
- Row-level security via app-layer scoping (every query filtered by org).
- Admin endpoints to register repos, configure destinations, manage prompts per org.
- Per-org rate limiting and LLM budget tracking.
- Migration plan for existing single-tenant data → assigned to a default org.

**Out of scope (still):** Self-serve signup, billing, public marketing site — those are Phase 8.

---

## Phase 6 — Additional sources and destinations

**Goal:** Make the platform pluggable so each org can pick their stack.

**Sources to add:** GitLab, Bitbucket.

**Destinations to add:** Linear (engineering changelog), Jira (release notes), Confluence (release docs), Microsoft Teams (alternative to Slack), generic webhook (for custom integrations).

**Key components:**
- Each new source implements the `Source` interface — webhook handlers per provider in `src/http/routes/webhooks/<provider>.ts` (kebab-case file names like `gitlab.ts`, `bitbucket.ts`).
- Each new destination implements the `Destination` interface.
- Per-org integration config decides which destinations receive which event types.

---

## Phase 7 — Cost optimization & scaling

**Goal:** Bring per-PR cost down and make the system ready for 10x traffic.

**Key components:**
- Tiered LLM strategy: cheap model (Haiku) for classification + small summaries, big model (Sonnet/Opus) only for consolidated release notes and themes.
- Caching: hash inputs, skip re-summarization when nothing meaningful changed.
- Diff chunking strategy: large PRs summarized file-by-file, then meta-summarized.
- Move worker to dedicated process (separate Railway service).
- Move queue to Redis/BullMQ if Postgres queue starts struggling (>100 jobs/min sustained).
- Observability: OpenTelemetry traces, per-org metrics dashboard.

---

## Phase 8 — Public dashboard & onboarding

**Goal:** External-facing product — self-serve signup, billing, web UI.

**Key components:**
- Web app (separate frontend): Next.js or Remix, hosted on Vercel/Railway.
- Auth: Clerk or WorkOS for SSO/SAML.
- Billing: Stripe with per-seat or per-PR pricing.
- Onboarding flow: connect GitHub → pick repo → connect Notion/Slack → see first summary in <5 minutes.
- Marketing site with docs, pricing, changelog (eat your own dog food).

---

## Done criteria checklist

A phase is done when:
1. All listed components are implemented and deployed.
2. The "Goal" statement at the top of the phase is verifiably true on real data.
3. No regressions in previous phases (smoke test: previous phases' done criteria still hold).
4. All commits in the phase follow Conventional Commits.
5. AGENTS.md has been updated if any architectural decision was changed during implementation.

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
  config/
    env.ts                  # Env var validation with Zod
  db/
    schema.ts               # Drizzle schemas
    client.ts               # Postgres + Drizzle client
    migrations/             # Generated migrations
  http/
    server.ts               # Fastify setup
    routes/
      webhooks.ts           # POST /webhooks/github
      webhook-release.ts   # push → process_release gating
      health.ts             # GET /health
  lib/
    plist-version.ts        # CFBundle* from XML plist
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

Validated in `src/config/env.ts` with Zod. Required vars below must be set or boot fails. Optional vars are documented inline.

```
# Postgres (Railway provides automatically when you attach the DB)
DATABASE_URL=postgres://...

# GitHub App
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=    # Contents of the .pem, with \n preserved
GITHUB_WEBHOOK_SECRET=     # Secret defined when creating the app

# Optional: restrict PR summarization to PRs merged into one of these base branches
# (GitHub: pull_request.base.ref). Comma-separated, trimmed. Example: develop or develop,release.
# If unset or empty, every merged PR is summarized (original Phase 1 behavior).
# PR_SUMMARY_BASE_BRANCHES=develop

# Anthropic
ANTHROPIC_API_KEY=

# Notion
NOTION_TOKEN=              # Internal integration token
NOTION_DATABASE_ID=        # Database where PRs become pages

# Optional — iOS release notes (Phase 2). If NOTION_RELEASES_DATABASE_ID is set, RELEASE_INFO_PLIST_PATH and RELEASE_VERSION_BRANCH are required. Tag creation stays in CI; the service reads the repo via the GitHub API.
# If the main Info.plist only contains `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)` (no literal numbers), set RELEASE_PROJECT_PBXPROJ_PATH to the `*.xcodeproj/project.pbxproj` where `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` are bumped (e.g. `make increment-version`).
# NOTION_RELEASES_DATABASE_ID=
# RELEASE_INFO_PLIST_PATH=Info.plist
# Optional — required for placeholder plists: path to pbx (repo-relative).
# RELEASE_PROJECT_PBXPROJ_PATH=MyApp.xcodeproj/project.pbxproj
# RELEASE_VERSION_BRANCH=develop
# Optional: only this repo (owner/name) can enqueue process_release. If unset, any installed repo is allowed.
# RELEASE_MONITORED_REPO=acme/ios-app
# Optional: Git SHA used as the left edge of the first GitHub compare on a marketing line when no prior release exists (see docs/release-compare-windows.md).
# RELEASE_COMPARE_ROOT_SHA=

# App
PORT=3000
LOG_LEVEL=info
NODE_ENV=development
```

---

## Roadmap (phases)

The project is divided into phases. Each phase is a coherent, shippable unit of scope. Phases build on each other but each one delivers value on its own — so the project is always "done" at any phase boundary.

| Phase | Name                            | Status      |
|-------|---------------------------------|-------------|
| 1     | Core PR ingestion               | Completed   |
| 2     | Version bump detection          | Completed   |
| 3     | Slack digest                    | Planned     |
| 4     | Multi-PR thematic threads       | Planned     |
| 5     | Multi-repo + multi-tenancy      | Planned     |
| 6     | Additional sources/destinations | Planned     |
| 7     | Cost optimization & scaling     | Planned     |
| 8     | Public dashboard & onboarding   | Planned     |

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

**Goal:** When a push to the configured branch updates the app’s visible iOS version (from XML `Info.plist` or, when configured, from `project.pbxproj` literals), generate consolidated release notes in a **second Notion database** and persist one row per logical version in `releases`.

**Behavior:**
- GitHub `push` to `RELEASE_VERSION_BRANCH` (e.g. `develop`). Enqueue is skipped unless the push likely touched `RELEASE_INFO_PLIST_PATH` or (if set) `RELEASE_PROJECT_PBXPROJ_PATH` — e.g. a bump that only edits `project.pbxproj` still enqueues when that path is configured. (If the batch has 20 commits — GitHub cap — the handler assumes something may have changed and the job re-checks by comparing SHAs.) Creating tags in GitHub is **out of scope** (CI); Shipnot only reads the API.
- Job `process_release`: read plist/pbx at the push webhook’s `before` / `after` SHAs. The GitHub compare range for commits/PR hints may use a **wider** left edge: build-only bumps anchor to the latest prior `releases.head_sha` for the same `repo`, `branch`, and `short_version` (fallback: optional `RELEASE_COMPARE_ROOT_SHA`, then webhook `before`); marketing bumps use the earliest stored `marketing_era_start_sha` on the old `short_version`, then the latest prior `head_sha` on that line, then the same fallbacks (`docs/release-compare-windows.md`). If `RELEASE_PROJECT_PBXPROJ_PATH` is set, read `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` from that file at each SHA; otherwise read the plist. If the plist only contains `$(...)` placeholders and no pbx path is set, the job fails with a clear config error. The GitHub compare range supplies every commit (`compareCommits`); commits that are **not** merge/squash PR lines are passed as `standaloneCommitHints` to the LLM. For each PR number found in that range, matching rows in `pull_requests` (same `repo`) enrich the input with stored `summary_user_facing` when the PR was processed earlier. The prompt `release-changelog.md` returns user-facing **changelog** copy only (no engineering appendix), stored in `releases.changelog`, with optional sectioned bullets; Notion page body shows **Changelog** + sections. Persist the effective compare base in `releases.before_sha` and the marketing-line era anchor in `releases.marketing_era_start_sha` (first row on a `short_version` sets it; later rows reuse it).
- Idempotency: `releases` has unique (`repo`, `version_key`).

**Compare windows:** Implemented per `docs/release-compare-windows.md` (`resolve-release-compare-before`, `gather-release-context` `compareBeforeSha`, optional `RELEASE_COMPARE_ROOT_SHA`, column `releases.marketing_era_start_sha`).

**Notion “Releases” database properties (must match integration):** Title, Repo, Branch, Version, Short Version, Build, Previous Version, URL, PR Numbers (see `notion-destination`).

**Out of scope:** Plist **binary** format, Android, App Store Connect, creating git tags.

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

# Driff V1 technical audit

Status: accepted implementation baseline for the version-aware Driff V1.

## Product boundary

Driff V1 is a searchable engineering change memory. Its primary job is to answer what changed, when it changed, in which version, and who participated, with links to the underlying evidence. Release-note publishing remains an output of that memory, not the product's organizing model.

The first supported source is GitHub. A project must have a deterministic version strategy. Notion remains an optional destination. Individual productivity scores, public changelogs, Slack, GitLab, Bitbucket, Jira/Linear, DORA metrics, and general current-codebase question answering are outside V1.

## Current-state inventory

### Back end

The existing service already provides a strong ingestion and SaaS foundation:

- signed GitHub webhooks with delivery-level idempotency;
- asynchronous Postgres-backed jobs with retry, failure state, and queue health;
- merged-PR, direct-push, and version-bump processing pipelines;
- GitHub user OAuth for repository onboarding and GitHub App credentials for runtime reads;
- provider-agnostic workspace and source seams, with GitHub as the implemented source;
- multi-tenant teams, membership roles, invitations, and team-scoped workspace access;
- version-source inference for iOS and Expo, with Android and Flutter detection reserved;
- dual user-facing/technical AI summaries, prompt versions, and LLM usage metering;
- pluggable destinations and multi-tenant Notion OAuth;
- summary list/detail HTTP APIs, basic search, pagination, and readiness diagnostics.

Important constraints in the current model:

- pull requests, pushes, and releases are keyed by repository text rather than workspace foreign keys;
- a source-provider/repository pair can belong to only one workspace globally;
- releases are created only from supported version-file bumps and are not a generic version entity;
- PR, push, and release records are separate summaries, not nodes in one change model;
- evidence is implicit in SHAs, PR numbers, and compare URLs rather than represented per claim;
- areas are free-form LLM output and have no stable user-managed identity;
- there is no historical backfill, semantic retrieval, Ask endpoint, lineage, version comparison API, or correction workflow;
- PR and push records do not retain the file/evidence graph needed for later reconstruction.

### Front end

The existing React application already provides:

- Google session authentication and team switching;
- repository-linked onboarding;
- project shell, settings, readiness diagnostics, and Notion integration;
- summary feed and detail routes for PR, push, and version records;
- TanStack Router/Query, Zod API boundaries, semantic UI primitives, and six locales.

The current information architecture is event-type first: Summary, Releases, Pull requests, and Pushes. V1 needs to become version/change first. PRs and commits remain evidence reached through drill-down rather than equal top-level product destinations.

## Keep, adapt, retire, create

| Decision     | Current capability                                    | V1 treatment                                                                                |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Keep         | Fastify, Drizzle, Postgres queue, worker resilience   | Reuse without a platform rewrite.                                                           |
| Keep         | Google auth, teams, roles, invitations                | Extend access checks to every new query and Ask result.                                     |
| Keep         | GitHub OAuth/App, signature verification, webhook log | Use as the live ingestion boundary and backfill credential source.                          |
| Keep         | Source and destination registries                     | Keep GitHub-only and Notion-optional for V1.                                                |
| Keep         | Dual summaries, prompt history, usage metering        | Evolve into evidence-backed structured summaries and evaluation.                            |
| Adapt        | `releases`                                            | Migrate toward canonical versions independent of one mobile bump strategy.                  |
| Adapt        | `pull_requests`, `pushes`, `releases`                 | Preserve as source records while projecting them into canonical changes.                    |
| Adapt        | release-project kinds and inference                   | Replace the mobile-only ceiling with version-strategy adapters and presets.                 |
| Adapt        | summary feed/detail APIs                              | Add a version timeline, version detail/compare, change detail, and cited answers.           |
| Adapt        | onboarding                                            | End at first useful historical answer, with backfill progress before optional destinations. |
| Adapt        | areas                                                 | Replace free-form strings with stable workspace-defined product areas and rules.            |
| De-emphasize | PR/push/release top-level tabs                        | Keep as technical filters or evidence views, not primary navigation.                        |
| De-emphasize | estimated time-saved and activity counts              | Do not present them as individual or team productivity measures.                            |
| Create       | Driff Lab                                             | Deterministic fixtures and replay through the real webhook pipeline.                        |
| Create       | Historical backfill                                   | Import a bounded date/version window with progress, retry, resume, and idempotency.         |
| Create       | Canonical change graph                                | Relate workspace, version, change, evidence, product area, and contributor roles.           |
| Create       | Ask Driff                                             | Permission-scoped retrieval with citations and an explicit insufficient-evidence result.    |
| Create       | Change lineage                                        | Track introduction, subsequent changes, removal/revert, and human corrections.              |
| Create       | Evaluation harness                                    | Golden questions and evidence, regression metrics, latency, and cost.                       |

## Target canonical model

The target model is additive. Existing source tables continue to support today's pipelines while new projections are introduced and backfilled.

### `project_versions`

One canonical version within a workspace.

- `workspace_id`
- normalized display and comparison values
- optional build value
- status: `released` or `in_development`
- strategy: GitHub release, Git tag, or version file
- source reference and evidence URL
- boundary SHAs and release timestamp
- unique workspace/strategy/source-reference identity

### `changes`

The user-understandable unit of change.

- `workspace_id` and nullable `version_id`
- title, executive summary, and technical summary
- category and confidence
- first/last occurrence timestamps
- generation and correction metadata
- stable URL identity

### `change_evidence`

The provenance layer behind summaries and answers.

- `change_id`
- evidence kind: PR, commit, file, compare, release, or version marker
- provider external ID, URL, SHA/path, and occurrence timestamp
- a minimal validated metadata payload
- an optional source-record reference during migration

### `product_areas` and `change_areas`

Stable workspace-owned names and matching rules, with a many-to-many change relation. Generated files, lockfiles, bots, and sensitive paths are exclusion rules rather than ad-hoc prompt instructions.

### `change_contributors`

A change/person relation with explicit roles such as PR author, commit author, reviewer, and co-author. This table exists for context reconstruction only; it must not feed rankings or performance scores.

### `change_lineages`

Human-correctable groupings that connect a product feature or area to an ordered set of changes. Automated suggestions must retain confidence and may be merged or split by an authorized user.

### Retrieval documents

Search documents retain only the text and provenance required for change-history retrieval. The initial implementation should prefer Postgres-native lexical retrieval and measured structured filters; semantic embeddings are added only when the evaluation corpus demonstrates a material quality gain.

## Version strategy boundary

Version detection becomes an adapter contract instead of a growing conditional:

1. GitHub Release identifier and target SHA;
2. SemVer-like Git tag and target SHA;
3. configured repository file plus a parser preset or extraction rule;
4. one synthetic `in_development` version after the newest released boundary.

Initial file presets cover the already implemented iOS plist/pbxproj and Expo formats, then `package.json`, `pyproject.toml`, Cargo, Maven/Gradle, Android, and Flutter in measured increments. Detection may suggest a strategy, but the user confirms it before backfill.

## Incremental delivery plan

### P0 — prove the development loop

1. Add the Driff Lab scenario contract and deterministic fixtures.
2. Validate fixtures without network or database side effects.
3. Replay signed fixtures against the existing webhook endpoint, local by default and remote only through an explicit development-host allowlist.
4. Build a corpus of expected jobs and later expected summaries/answers.

### P1 — establish canonical history

1. Add version-strategy interfaces and GitHub release/tag support.
2. Add workspace-scoped canonical version/change/evidence tables.
3. Project live PR/push/release jobs into canonical records without changing existing destinations.
4. Add bounded backfill with progress and idempotent resume.
5. Add stable product areas and exclusions.

### P2 — ship the differentiating experience

1. Expose version timeline and change detail APIs.
2. Add version comparison from canonical changes.
3. Add evidence-backed structured summaries.
4. Add Ask Driff over structured filters plus retrieval, always with citations.
5. Add human-correctable change lineage.

### P3 — complete trust and collaboration

1. Apply role checks consistently to all new resources.
2. Add storage/retention/exclusion controls and administrative audit events.
3. Redesign onboarding around backfill and the first cited answer.
4. Adapt Notion publishing to canonical version views.

### P4 — validate and harden

1. Run prompt/retrieval regressions against the golden corpus.
2. Measure factual accuracy, citation precision, insufficient-evidence behavior, latency, and cost.
3. Instrument the first-value funnel without recording sensitive code or questions by default.

## Migration strategy

- Do not rename or remove existing summary tables in the first migration.
- Introduce canonical tables and dual-write projections behind tests.
- Backfill canonical records per workspace from the existing PR, push, and release rows.
- Add workspace foreign keys to new records even while source rows still use `repo`.
- Read the new timeline from canonical tables only after parity checks pass.
- Keep Notion publishing on existing source records until canonical projection is stable.
- Remove legacy reads and constraints only in later, independently reversible migrations.

## Main risks and mitigations

| Risk                                                       | Mitigation                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Repository history does not contain product intent         | Separate fact from inference, cite evidence, and return insufficient evidence. Add Jira/Linear only after V1 validation. |
| A functional area changes names or files                   | Use stable area identities, rules plus semantic hints, and human corrections.                                            |
| Backfill exhausts GitHub or LLM limits                     | Bound the import, checkpoint cursors, deduplicate, and summarize incrementally.                                          |
| Existing repo-global uniqueness blocks a legitimate tenant | Keep the V1 constraint for safe webhook routing, measure beta demand, then migrate to installation/repository identity.  |
| Semantic search adds cost before proving value             | Start with structured/version filters and lexical search; gate embeddings on corpus results.                             |
| Manager visibility becomes surveillance                    | Never rank individuals; show roles and evidence only; remove individual output comparisons from the default product.     |
| Lab events reach production                                | Localhost is allowed by default; every remote replay requires an explicit host allowlist and development confirmation.   |

## Definition of the first V1 milestone

Given a deterministic three-version GitHub fixture, Driff can replay it through the existing ingestion boundary, associate resulting source records with canonical versions and changes, and answer at least one golden question with correct version, participants, and evidence. The work remains incremental: each implementation is validated and committed separately using Conventional Commits.

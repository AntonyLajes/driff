# Release compare windows — product spec

This document defines **how Git compare intervals** (`before_sha` … `after_sha`) should be chosen so release notes match team intent: summarize work **during** a build or **during** an entire marketing-version era. It is the source of truth for future changes to `process_release` / enqueue logic; today’s implementation still uses the **push webhook’s** `before` / `after` SHAs unless noted otherwise.

---

## 1. Problem and goal

**Problem:** Small pushes (e.g. only a build bump) produce tiny Git diffs, so changelogs miss most work that happened “while we were on build N”.

**Goal:** Auto-documentation driven by **minimum version bumps** (build and/or marketing), with AI summaries sent to configured destinations (e.g. Notion).

---

## 2. Definitions

| Term | Meaning |
|------|---------|
| **Short version (marketing)** | e.g. `213`, `2.0` — as read from plist/pbx at a given SHA. |
| **Build** | `CURRENT_PROJECT_VERSION` / CFBundleVersion style build number at that SHA. |
| **`version_key`** | Stable key in app + DB, e.g. `short+build` → `213+2`. |
| **`head_sha`** | Branch tip SHA **after** the version bump landed (the `after` of the triggering push, or equivalent). |
| **`before_sha` / `after_sha` (compare)** | SHAs passed to GitHub **compare API** to list commits and derive PR hints for the LLM. |

---

## 3. Desired behavior

### 3.1 Build-only bump (same marketing, build increases)

**Example:** `213+1` → `213+2`.

**Narrative:** “Everything done **while** we were on **build 1**”, until the repo moved to build 2.

**Compare window:**

- `after_sha` = new state SHA where `213+2` is true (typically `head_sha` for this release).
- `before_sha` = anchor for the **start** of the work attributed to “during build 1”:
  - **Preferred:** `head_sha` of the **previous stored release** for the same `repo` + `branch` with the **same** `short_version` (last known build of that line). The compare is then **exclusive start / inclusive end** semantics as defined by GitHub’s `base...head` range — implementation must document the exact mapping (usually: commits reachable from `after` that are not ancestors of `before`, i.e. “what landed between the two tips” on the release branch).
  - **Fallback (no prior release on that marketing line):** configurable root SHA per repo (env, e.g. `RELEASE_COMPARE_ROOT_SHA`) or first commit on the branch; or conservatively use webhook `before` only for the first build of a line.

**Expected outcome:** The changelog reflects **all commits** merged while the project was still on build 1, not only the single bump commit.

### 3.2 Marketing version bump (e.g. entire `213.*` → `214`)

**Example:** Last build on `213` → first state on `214`.

**Narrative:** “Everything done **during the whole marketing version 213**”, across **all builds** on that line.

**Compare window:**

- `after_sha` = SHA where the new marketing version is already in effect (`214+…`).
- `before_sha` = start of the **213 era** on that branch. Two implementation tracks (pick one for v1; the other can be a later refinement):

| Track | Rule |
|-------|------|
| **A — explicit era anchor** | Persist `marketing_era_start_sha` (or equivalent) on the **first** `releases` row when `short_version` first becomes `213`; for the `213 → 214` bump, `before_sha` = that stored anchor (or the parent of the first commit that introduced `213`, if easier). |
| **B — simpler first iteration** | `before_sha` = `head_sha` of the **latest** prior `releases` row for same `repo`/`branch` whose `short_version` **differs** from the new one — **does not** fully cover “all of 213” if multiple majors existed; acceptable only as a stepping stone until **A** exists. |

**Recommendation:** Ship **build bump** logic (§3.1) first using **last release `head_sha`** chain; add **A** for marketing-era summaries when ready.

### 3.3 First release (no prior row in `releases`)

- No previous release: `before_sha` from env **`RELEASE_COMPARE_ROOT_SHA`** (optional), or branch root, or webhook `before` with explicit “first release” copy in the LLM input.
- Must not crash; idempotency on `(`repo`, `version_key`)` unchanged.

---

## 4. Persistence (MVP vs later)

**MVP (required):** Each `releases` row keeps at least `repo`, `branch`, `short_version`, `build`, `version_key`, `head_sha`, `before_sha` (actually used for compare), timestamps, plus changelog payload for Notion.

**Later (optional):** `marketing_era_start_sha` column; or `release_commits` table if we need offline replay without GitHub.

---

## 5. Where logic lives

- **`process_release`** (or a dedicated helper it calls): after resolving the **new** version from plist/pbx, compute `before_sha` / `after_sha` per this document, then call `gather-release-context` (or equivalent) with those SHAs.
- **Webhook payload:** `before` / `after` from GitHub remain a **fallback** when no prior release exists.

---

## 6. LLM / Notion output

- LLM input: full commit list + PR enrichment from `pull_requests` for PR numbers found in the **widened** range.
- Notion **PR Numbers** property: populated from deduplicated PR list for that range (even if the prose is short).

---

## 7. Out of scope (this spec)

- App Store Connect as source of truth for “shipped”.
- Rewriting history before the first anchor.
- Multi-tenant / multi-org (Phase 5).

---

## 8. Acceptance criteria (examples)

1. **Build 1 → 2** with many commits while on build 1: changelog reflects aggregated work, not only “internal bump”.
2. **Marketing bump** (when era logic is implemented): changelog spans the intended **213.* era**, not a single commit.
3. **Re-run** same `version_key`: idempotent — no duplicate Notion page / `releases` row.
4. **No prior release:** service does not crash; conservative messaging or configured root SHA.

---

## 9. Implementation status

| Area | Status |
|------|--------|
| PR enrichment, standalone commit hints, changelog prompt, Notion releases DB | Implemented |
| Compare window per §3.1 / §3.2 (anchors from `releases`) | **Not yet** — still uses webhook `before` / `after` from the push that enqueues `process_release` |

When implementation matches this spec, update the table above and add a short note in `AGENTS.md` Phase 2.

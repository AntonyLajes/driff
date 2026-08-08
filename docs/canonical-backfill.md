# Canonical history backfill

The backfill projects legacy `pull_requests`, `pushes`, and `releases` rows into
the workspace-scoped canonical timeline. It reuses stored summaries and never
calls the LLM or publishes to Notion.

## Safety model

- Dry-run is the default. Database writes require the explicit `--apply` flag.
- Both workspace UUID and `owner/repo` are required and must match the linked
  GitHub repository.
- Existing projections are discovered through source-record provenance and are
  not fetched or written again.
- Pull requests and pushes are projected before releases so a release can link
  the canonical changes in its compare window.
- GitHub network calls happen outside database transactions. Each canonical
  projector owns a short, idempotent transaction.
- Legacy rows with an incomplete PR or push summary are reported as skipped and
  remain visible as parity gaps.
- A second `--apply` run is safe: it inspects parity again and only processes
  source records that are still missing.

## Inspect without writing

```sh
npm run canonical:backfill -- \
  --workspace-id 11111111-1111-4111-8111-111111111111 \
  --repo acme/app
```

The JSON result contains the before/after parity report plus candidate, ready,
projected, and skipped totals for every source type. During a dry-run, `before`
and `after` are identical and `projected` is always zero.

## Apply

Review the dry-run result first, then repeat the exact command with `--apply`:

```sh
npm run canonical:backfill -- \
  --workspace-id 11111111-1111-4111-8111-111111111111 \
  --repo acme/app \
  --apply
```

The command exits non-zero on a GitHub or projection failure. Successfully
projected records remain committed; rerunning the command resumes from the
remaining parity gaps.

Required environment variables are `DATABASE_URL`, `GITHUB_APP_ID`, and
`GITHUB_APP_PRIVATE_KEY`.

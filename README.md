# ci-delta

[![CI](https://github.com/tengfone/ci-delta/actions/workflows/ci.yml/badge.svg)](https://github.com/tengfone/ci-delta/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/tengfone/ci-delta?sort=semver)](https://github.com/tengfone/ci-delta/releases)
[![npm](https://img.shields.io/npm/v/ci-delta)](https://www.npmjs.com/package/ci-delta)
[![GitHub Marketplace](https://img.shields.io/badge/GitHub%20Marketplace-ci--delta-0969da?logo=github)](https://github.com/marketplace/actions/ci-delta)

Semantic diff reports for CI/CD config changes.

A YAML diff tells you what text changed.
`ci-delta` tells you what pipeline behavior changed.

Like `terraform plan`, but for GitHub Actions.

## What It Catches

`ci-delta` compares GitHub Actions workflow files between a base ref and a head ref, then reports behavior changes that are easy to miss in raw YAML review:

- New or removed workflow files
- Invalid workflow YAML
- New high-risk triggers such as `pull_request_target`, `workflow_run`, and `schedule`
- Widened branch/path filters
- `GITHUB_TOKEN` write-permission elevation
- `id-token: write` and OIDC cloud authentication actions
- New `secrets.*` usage, including secrets in shell commands
- Pull request head checkout in privileged workflows
- Self-hosted runner, container, service, and shell changes
- Production deployment environment changes
- Action version changes, unpinning, floating refs, and Docker actions
- Job graph changes, including possible deploy gate removal

## CLI

Run the CLI with npm:

```bash
npx ci-delta github-actions --base origin/main --head HEAD
```

Provider aliases:

```bash
npx ci-delta gha --base origin/main --head HEAD
npx ci-delta github --base origin/main --head HEAD
```

Output formats:

```bash
npx ci-delta github-actions --base origin/main --head HEAD --format markdown
npx ci-delta github-actions --base origin/main --head HEAD --format json
```

JSON output includes a top-level `schemaVersion` field. The v0 JSON report
schema version is `ci-delta.report.v1`.

Useful options:

```txt
--output <file>                 write the report to a file
--fail-on low|medium|high|critical|none
--repo-root <path>              repository root for local git reads
--include <glob>                include additional workflow-like files
--no-color                      reserved for CLI compatibility
```

By default, `--fail-on none` is used. The CLI explains changes without failing builds unless a threshold is configured.

Exit codes:

```txt
0 = completed, no failing severity reached
1 = findings at or above --fail-on threshold
2 = usage or configuration error
3 = parse/runtime error
```

## GitHub Action

```yaml
name: CI Delta

on:
  pull_request_target:
    types: [opened, synchronize, reopened, edited]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  ci-delta:
    runs-on: ubuntu-latest
    steps:
      - uses: tengfone/ci-delta@v0
        with:
          provider: github-actions
          comment: true
          fail-on: none
          format: markdown
```

The action reads base and head workflow files through the GitHub API. It does not check out pull request code, execute workflow contents, run package scripts from the PR branch, or invoke changed workflows.

Action inputs:

```txt
provider       github-actions for v0
comment        post or update a sticky PR comment, default true
fail-on        none, low, medium, high, or critical
format         markdown or json
github-token   token for API reads and comments, default github.token
```

The PR comment uses this marker so updates replace the previous report:

```md
<!-- ci-delta-report -->
```

## Example Report

See a real smoke-test PR and sticky report:
[tengfone/ci-delta#5](https://github.com/tengfone/ci-delta/pull/5#issuecomment-4275678904).

```md
## CI Delta Report

Risk: Critical

Changed workflow files:

- `.github/workflows/release.yml`

### Critical

#### Pull request head checkout has write token access

File: `.github/workflows/release.yml`

Evidence:

- Workflow is triggered by `pull_request_target`.
- Checkout uses pull request head code (repository: `${{ github.event.pull_request.head.repo.full_name }}`, ref: `${{ github.event.pull_request.head.sha }}`).
- Job or workflow grants write access to `GITHUB_TOKEN`.

Recommendation: Avoid checking out pull request head code in privileged workflows. Use the merge commit or run untrusted code in a separate pull_request workflow with read-only permissions.
```

## Security Model

`ci-delta` reviews CI/CD changes, so the action wrapper is intentionally narrow:

- Uses `pull_request_target` only for metadata, file reads, summaries, and comments
- Reads workflow files through GitHub Git tree/blob APIs
- Supports fork PRs by reading base and head repositories separately
- Does not checkout PR code
- Does not run shell commands from workflow files
- Does not execute package scripts from the PR branch
- Does not evaluate GitHub Actions expressions
- Posts a sticky PR comment instead of emitting generated workflow commands

The local CLI uses `git ls-tree` and `git show` for trusted local refs.

## Rule Model

`ci-delta` is a static analyzer for known high-risk CI/CD configuration
changes. Rules are intentionally evidence-driven: findings cite concrete YAML
changes such as new triggers, widened permissions, new secret usage, or checkout
of pull request head code in privileged workflows.

The v0 rule set is maintained in code. It does not execute workflows, emulate
GitHub Actions runtime behavior, or support custom user-defined rules. Unknown
new trigger names are still reported as generic workflow trigger additions, but
they will not receive specialized severity or recommendations until the rule
set is updated.

## Data Handling

The GitHub Action reads pull request metadata and workflow file contents from
the base and head repositories through GitHub APIs. When `comment: true` is
enabled, it posts or updates one sticky pull request comment containing the CI
Delta report.

`ci-delta` does not send repository contents, workflow files, pull request data,
tokens, or generated reports to third-party services. It does not persist data
outside the current GitHub Actions run.

## Development

```bash
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
npm run verify:action
npm run verify:package
```

The production packaging gate is:

```bash
npm run prepack
```

`npm run prepack` type-checks, checks formatting, runs tests, rebuilds `dist`, and verifies that `action.yml` points at a standalone Node 24 action bundle.

`npm run verify:package` packs the npm artifact, installs it into a temporary
project, and verifies both the `ci-delta` binary and package import entrypoint.

Fixtures live in `fixtures/github-actions`. Each fixture has `base`, `head`, `expected.json`, and `expected.md` files and is exercised by the Vitest suite.

## Release Process

Stable releases are driven by GitHub Releases:

1. Update `package.json` to the next stable semver version and merge to `main`.
2. Create and publish a GitHub Release whose tag exactly matches the package version, such as `v0.1.2`.
3. The `Release` workflow verifies the tag, runs the production package gates, publishes the package to npm, and moves the matching major action tag, such as `v0`.

Prereleases are not published automatically yet. Keep `v*` release tags protected with GitHub repository rules so only maintainers can create or move release tags.

Before using automated npm publishing, configure npm Trusted Publishing for this package:

- Publisher: GitHub Actions
- Organization or user: `tengfone`
- Repository: `ci-delta`
- Workflow filename: `release.yml`
- Environment: leave blank

The release workflow uses GitHub OIDC for npm publishing. Do not store a long-lived npm publish token in repository secrets.

## Limitations

`ci-delta` is not a workflow runtime emulator. It does not execute workflows, resolve every expression, scan secret values, enforce branch protection, replace CodeQL, or fully expand reusable workflows.

The v0 implementation focuses on GitHub Actions workflow files:

```txt
.github/workflows/*.yml
.github/workflows/*.yaml
```

Findings are conservative and evidence-driven. When a rule cannot prove the full runtime behavior, it reports the concrete config delta and recommends human review.

## Roadmap

The provider interface is intentionally CI/CD-platform neutral. GitLab CI support is planned as a future adapter with a command such as:

```bash
npx ci-delta gitlab-ci --base origin/main --head HEAD
```

Future GitLab work should cover `.gitlab-ci.yml`, local includes, `workflow:rules`, job rules, variables, protected environment changes, runner tags, images/services, `id_tokens`, deployment gates, and child pipeline triggers.

# ci-delta

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

Install or run with npm:

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
```

The production packaging gate is:

```bash
npm run prepack
```

`npm run prepack` type-checks, checks formatting, runs tests, rebuilds `dist`, and verifies that `action.yml` points at a standalone Node 24 action bundle.

Fixtures live in `fixtures/github-actions`. Each fixture has `base`, `head`, `expected.json`, and `expected.md` files and is exercised by the Vitest suite.

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

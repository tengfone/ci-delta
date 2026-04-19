# ci-delta

Semantic diff reports for CI/CD config changes.

A YAML diff tells you what text changed.
`ci-delta` tells you what pipeline behavior changed.

Like `terraform plan`, but for CI/CD config changes.

## Status

This repository currently contains a v0 scaffold:

- npm CLI entry point
- core finding/report types
- Local Git file-source plumbing
- GitHub Actions provider adapter skeleton
- markdown/json reporters
- GitHub Action wrapper entry point stub

## Usage

```bash
npx ci-delta github-actions --base origin/main --head HEAD
```

Aliases:

```bash
npx ci-delta gha --base origin/main --head HEAD
npx ci-delta github --base origin/main --head HEAD
```

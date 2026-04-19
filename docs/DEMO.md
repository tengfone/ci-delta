# Demo

## Before

```yaml
name: Release

on: pull_request

permissions:
  contents: read

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
```

## After

```yaml
name: Release

on: pull_request_target

permissions:
  contents: write
  id-token: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          repository: ${{ github.event.pull_request.head.repo.full_name }}
          ref: ${{ github.event.pull_request.head.sha }}
      - run: npm publish --token ${{ secrets.NPM_TOKEN }}
```

## Example PR Comment

```md
<!-- ci-delta-report -->

## CI Delta Report

Risk: Critical

Changed workflow files:

- `.github/workflows/release.yml`

### Critical

#### Pull request head checkout has write token access

File: `.github/workflows/release.yml`

Evidence:

- Workflow is triggered by `pull_request_target`.
- Checkout uses pull request head code.
- Job or workflow grants write access to `GITHUB_TOKEN`.

Recommendation: Avoid checking out pull request head code in privileged workflows.
```

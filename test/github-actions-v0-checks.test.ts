import { describe, expect, it } from "vitest";
import { GitHubActionsAdapter } from "../src/providers/github-actions/adapter.js";
import type { Finding } from "../src/core/types.js";

const adapter = new GitHubActionsAdapter();

describe("GitHub Actions remaining v0 checks", () => {
  it("detects trigger filter widening and path filter removal", async () => {
    const findings = await diff({
      base: `
on:
  push:
    branches: [main]
    paths:
      - src/**
jobs:
  test:
    runs-on: ubuntu-latest
    steps: []
`,
      head: `
on:
  push:
jobs:
  test:
    runs-on: ubuntu-latest
    steps: []
`,
    });

    expect(findingsById(findings)).toMatchObject({
      "trigger-filter-widened": "high",
      "trigger-path-filter-removed": "medium",
    });
  });

  it("detects OIDC cloud auth actions", async () => {
    const findings = await diff({
      base: `
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps: []
`,
      head: `
on: push
permissions:
  id-token: write
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
`,
    });

    expect(findingsById(findings)).toMatchObject({
      "permission-id-token-write-added": "critical",
      "oidc-cloud-auth-added": "critical",
    });
  });

  it("detects runner and execution environment changes", async () => {
    const findings = await diff({
      base: `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        shell: bash
`,
      head: `
on: push
jobs:
  build:
    runs-on: [self-hosted, linux]
    container:
      image: node:latest
    services:
      docker:
        image: docker:dind
        options: --privileged
    steps:
      - run: echo hi
        shell: pwsh
`,
    });

    expect(findingsById(findings)).toMatchObject({
      "self-hosted-runner-added": "high",
      "container-image-changed": "medium",
      "privileged-service-added": "high",
      "shell-changed": "low",
    });
  });

  it("detects production deployment environment changes", async () => {
    const findings = await diff({
      base: `
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: staging
    steps: []
`,
      head: `
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: production
    steps: []
`,
    });

    expect(findingsById(findings)).toMatchObject({
      "deployment-production-added": "critical",
    });
  });

  it("detects action unpinning and floating refs", async () => {
    const findings = await diff({
      base: `
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: example/action@0123456789abcdef0123456789abcdef01234567
`,
      head: `
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: example/action@main
`,
    });

    expect(findingsById(findings)).toMatchObject({
      "action-unpinned": "high",
    });
  });

  it("detects deploy gate dependency removal", async () => {
    const findings = await diff({
      base: `
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps: []
  deploy:
    runs-on: ubuntu-latest
    needs: [test]
    steps: []
`,
      head: `
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps: []
  deploy:
    runs-on: ubuntu-latest
    steps: []
`,
    });

    expect(findingsById(findings)).toMatchObject({
      "job-dependency-removed": "medium",
      "possible-deploy-gate-removed": "high",
    });
  });
});

async function diff(params: {
  base: string;
  head: string;
}): Promise<Finding[]> {
  const path = ".github/workflows/test.yml";
  const [base, head] = await Promise.all([
    adapter.parse([{ path, content: params.base }]),
    adapter.parse([{ path, content: params.head }]),
  ]);

  return adapter.diff(base, head);
}

function findingsById(
  findings: Finding[],
): Record<string, Finding["severity"]> {
  return Object.fromEntries(
    findings.map((finding) => [finding.id, finding.severity]),
  );
}

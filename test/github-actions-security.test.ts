import { describe, expect, it } from "vitest";
import { GitHubActionsAdapter } from "../src/providers/github-actions/adapter.js";
import type { Finding } from "../src/core/types.js";

const adapter = new GitHubActionsAdapter();
const workflowPath = ".github/workflows/release.yml";

describe("GitHub Actions security checks", () => {
  it("detects the critical pull_request_target unsafe checkout pattern", async () => {
    const findings = await diffWorkflows({
      base: `
name: Release
on: pull_request
permissions:
  contents: read
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`,
      head: `
name: Release
on:
  pull_request_target:
permissions:
  contents: write
  id-token: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          repository: \${{ github.event.pull_request.head.repo.full_name }}
          ref: \${{ github.event.pull_request.head.sha }}
      - run: echo "\${{ secrets.NPM_TOKEN }}"
`,
    });

    expect(findingsById(findings)).toMatchObject({
      "trigger-pull-request-target-added": "critical",
      "permission-sensitive-write-added": "high",
      "permission-id-token-write-added": "critical",
      "secret-with-pr-target": "critical",
      "untrusted-checkout-with-write-token": "critical",
      "untrusted-checkout-with-secrets": "critical",
    });
  });

  it("detects secrets added to shell commands outside pull_request_target", async () => {
    const findings = await diffWorkflows({
      base: `
on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`,
      head: `
on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: npm publish --token \${{ secrets.NPM_TOKEN }}
`,
    });

    expect(findingsById(findings)).toMatchObject({
      "secret-in-run-command-added": "high",
    });
  });

  it("treats workflow-level secret env as inherited by untrusted checkout jobs", async () => {
    const findings = await diffWorkflows({
      base: `
name: Release
on:
  pull_request_target:
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
`,
      head: `
name: Release
on:
  pull_request_target:
env:
  TOKEN: \${{ secrets.NPM_TOKEN }}
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
`,
    });

    expect(findingsById(findings)).toMatchObject({
      "secret-with-pr-target": "critical",
      "untrusted-checkout-with-secrets": "critical",
    });
  });
});

async function diffWorkflows(params: {
  base: string;
  head: string;
}): Promise<Finding[]> {
  const [base, head] = await Promise.all([
    adapter.parse([{ path: workflowPath, content: params.base }]),
    adapter.parse([{ path: workflowPath, content: params.head }]),
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

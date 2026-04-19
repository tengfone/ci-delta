import { describe, expect, it } from "vitest";
import { GitHubActionsAdapter } from "../src/providers/github-actions/adapter.js";

const adapter = new GitHubActionsAdapter();

describe("GitHubActionsAdapter parser", () => {
  it("handles string-form triggers", async () => {
    const snapshot = await parseWorkflow("on: push\njobs: {}\n");

    expect(Object.keys(snapshot.workflows[0]?.triggers ?? {})).toEqual([
      "push",
    ]);
  });

  it("handles array-form triggers", async () => {
    const snapshot = await parseWorkflow(
      "on: [push, pull_request]\njobs: {}\n",
    );

    expect(Object.keys(snapshot.workflows[0]?.triggers ?? {})).toEqual([
      "push",
      "pull_request",
    ]);
  });

  it("handles object-form triggers and keeps on as a string key", async () => {
    const snapshot = await parseWorkflow(`
name: Release
on:
  push:
    branches: [main]
    paths:
      - src/**
  pull_request:
    branches:
      - main
jobs: {}
`);

    const workflow = snapshot.workflows[0];
    expect(workflow?.parsed).toHaveProperty("on");
    expect(workflow?.triggers.push?.branches).toEqual(["main"]);
    expect(workflow?.triggers.push?.paths).toEqual(["src/**"]);
    expect(workflow?.triggers.pull_request?.branches).toEqual(["main"]);
  });

  it("normalizes workflow and job permissions", async () => {
    const snapshot = await parseWorkflow(`
on: push
permissions:
  contents: read
  id-token: write
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps: []
`);

    const workflow = snapshot.workflows[0];
    expect(workflow?.permissions.scopes).toEqual({
      contents: "read",
      "id-token": "write",
    });
    expect(workflow?.jobs.release?.permissions.scopes).toEqual({
      contents: "write",
    });
  });

  it("normalizes job execution fields", async () => {
    const snapshot = await parseWorkflow(`
on: push
jobs:
  deploy:
    runs-on: [self-hosted, linux]
    needs: [test]
    environment:
      name: production
    container:
      image: node:latest
    services:
      docker:
        image: docker:dind
        options: --privileged
    steps:
      - uses: actions/checkout@v4
      - run: echo "$TOKEN"
        shell: bash
        env:
          TOKEN: \${{ secrets.TOKEN }}
`);

    const job = snapshot.workflows[0]?.jobs.deploy;
    expect(job?.runsOn).toEqual(["self-hosted", "linux"]);
    expect(job?.needs).toEqual(["test"]);
    expect(job?.environment).toBe("production");
    expect(job?.containerImage).toBe("node:latest");
    expect(job?.services[0]).toMatchObject({
      name: "docker",
      image: "docker:dind",
      options: "--privileged",
    });
    expect(job?.steps[0]?.uses).toBe("actions/checkout@v4");
    expect(job?.steps[1]?.shell).toBe("bash");
  });

  it("returns high severity parse findings for invalid YAML", async () => {
    const snapshot = await parseWorkflow("on: [push\n");

    expect(snapshot.parseFindings[0]).toMatchObject({
      id: "workflow-parse-error",
      severity: "high",
      file: ".github/workflows/test.yml",
    });
    expect(snapshot.workflows).toEqual([]);
  });
});

async function parseWorkflow(content: string) {
  return adapter.parse([
    {
      path: ".github/workflows/test.yml",
      content,
    },
  ]);
}

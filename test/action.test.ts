import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAction, upsertStickyComment } from "../src/action/index.js";
import { GitHubApiFileSource } from "../src/file-sources/github-api.js";

describe("GitHubApiFileSource", () => {
  it("lists and reads workflow files from GitHub trees and blobs", async () => {
    const fetchMock = createGitHubFetchMock({
      "acme/repo@abc": {
        ".github/workflows/ci.yml": "name: CI\non: push\njobs: {}\n",
        "README.md": "# repo\n",
      },
    });

    const source = new GitHubApiFileSource({
      repository: { owner: "acme", repo: "repo" },
      ref: "abc",
      token: "token",
      apiUrl: "https://api.github.test",
      fetchImpl: fetchMock.fetch,
    });

    expect(await source.listFiles([".github/workflows/*.yml"])).toEqual([
      {
        path: ".github/workflows/ci.yml",
        content: "name: CI\non: push\njobs: {}\n",
        sha: "blob-acme-repo-abc-0",
      },
    ]);
  });

  it("fails closed when GitHub returns a truncated tree", async () => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse({
        truncated: true,
        tree: [
          {
            path: ".github/workflows/ci.yml",
            type: "blob",
            sha: "blob-sha",
          },
        ],
      });

    const source = new GitHubApiFileSource({
      repository: { owner: "acme", repo: "repo" },
      ref: "abc",
      token: "token",
      apiUrl: "https://api.github.test",
      fetchImpl: fetchMock,
    });

    await expect(source.listFiles([".github/workflows/*.yml"])).rejects.toThrow(
      /tree response.*truncated/i,
    );
  });
});

describe("runAction", () => {
  it("compares PR workflow files, writes summary, posts sticky comment, and applies fail-on", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ci-delta-action-"),
    );
    const eventPath = path.join(tempDir, "event.json");
    const summaryPath = path.join(tempDir, "summary.md");
    await fs.writeFile(
      eventPath,
      JSON.stringify({
        repository: { full_name: "acme/repo" },
        pull_request: {
          number: 42,
          base: {
            sha: "base-sha",
            repo: { full_name: "acme/repo" },
          },
          head: {
            sha: "head-sha",
            repo: { full_name: "contrib/repo" },
          },
        },
      }),
      "utf8",
    );

    const fetchMock = createGitHubFetchMock({
      "acme/repo@base-sha": {
        ".github/workflows/release.yml": `
name: Release
on: pull_request
jobs:
  release:
    runs-on: ubuntu-latest
    steps: []
`,
      },
      "contrib/repo@head-sha": {
        ".github/workflows/release.yml": `
name: Release
on: pull_request_target
jobs:
  release:
    runs-on: ubuntu-latest
    steps: []
`,
      },
    });

    const result = await runAction({
      env: {
        GITHUB_API_URL: "https://api.github.test",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        "INPUT_GITHUB-TOKEN": "token",
        "INPUT_FAIL-ON": "critical",
        INPUT_COMMENT: "true",
        INPUT_FORMAT: "markdown",
        INPUT_PROVIDER: "github-actions",
      },
      fetchImpl: fetchMock.fetch,
    });

    expect(result.failed).toBe(true);
    expect(result.report.maxSeverity).toBe("critical");
    expect(await fs.readFile(summaryPath, "utf8")).toContain(
      "pull_request_target trigger added",
    );
    expect(fetchMock.calls).toContainEqual(
      expect.objectContaining({
        method: "POST",
        url: "https://api.github.test/repos/acme/repo/issues/42/comments",
      }),
    );
  });
});

describe("upsertStickyComment", () => {
  it("updates an existing sticky comment", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });

      if (method === "GET") {
        return jsonResponse([
          { id: 10, body: "<!-- ci-delta-report -->\nold report" },
        ]);
      }

      return jsonResponse({ id: 10 });
    };

    await upsertStickyComment({
      apiUrl: "https://api.github.test",
      token: "token",
      repository: { owner: "acme", repo: "repo" },
      issueNumber: 42,
      body: "<!-- ci-delta-report -->\nnew report",
      fetchImpl: fetchMock,
    });

    expect(calls.at(-1)).toEqual({
      url: "https://api.github.test/repos/acme/repo/issues/comments/10",
      method: "PATCH",
      body: { body: "<!-- ci-delta-report -->\nnew report" },
    });
  });
});

function createGitHubFetchMock(refs: Record<string, Record<string, string>>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; method: string; body?: unknown }>;
} {
  const blobContent = new Map<string, string>();
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];

  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });

    const treeMatch = url.match(
      /^https:\/\/api\.github\.test\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([^?]+)\?recursive=1$/,
    );
    if (treeMatch) {
      const [, owner, repo, ref] = treeMatch;
      const key = `${owner}/${repo}@${ref}`;
      const files = refs[key] ?? {};
      const tree = Object.entries(files).map(([filePath, content], index) => {
        const sha = `blob-${owner}-${repo}-${ref}-${index}`;
        blobContent.set(`${owner}/${repo}/${sha}`, content);
        return { path: filePath, type: "blob", sha };
      });
      return jsonResponse({ tree });
    }

    const blobMatch = url.match(
      /^https:\/\/api\.github\.test\/repos\/([^/]+)\/([^/]+)\/git\/blobs\/(.+)$/,
    );
    if (blobMatch) {
      const [, owner, repo, sha] = blobMatch;
      const content = blobContent.get(`${owner}/${repo}/${sha}`);
      if (content === undefined) {
        return jsonResponse({ message: "not found" }, 404, "Not Found");
      }

      return jsonResponse({
        sha,
        encoding: "base64",
        content: Buffer.from(content, "utf8").toString("base64"),
      });
    }

    if (
      url ===
      "https://api.github.test/repos/acme/repo/issues/42/comments?per_page=100"
    ) {
      return jsonResponse([]);
    }

    if (
      url === "https://api.github.test/repos/acme/repo/issues/42/comments" &&
      method === "POST"
    ) {
      return jsonResponse({ id: 1 });
    }

    return jsonResponse({ message: `Unhandled URL: ${url}` }, 404, "Not Found");
  };

  return { fetch: fetchMock, calls };
}

function jsonResponse(
  value: unknown,
  status = 200,
  statusText = "OK",
): Response {
  return new Response(JSON.stringify(value), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

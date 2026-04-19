import { promises as fs } from "node:fs";
import { compareSources } from "../core/engine.js";
import { meetsThreshold } from "../core/severity.js";
import type { Report, Severity } from "../core/types.js";
import {
  GitHubApiFileSource,
  parseGitHubRepository,
} from "../file-sources/github-api.js";
import { GitHubActionsAdapter } from "../providers/github-actions/adapter.js";
import { reportToJson } from "../reporters/json.js";
import { reportToMarkdown } from "../reporters/markdown.js";

const stickyCommentMarker = "<!-- ci-delta-report -->";

export interface ActionRunOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface ActionRunResult {
  report: Report;
  failed: boolean;
  markdown: string;
  output: string;
}

interface PullRequestEvent {
  pull_request?: {
    number: number;
    base: {
      sha: string;
      repo: {
        full_name: string;
      };
    };
    head: {
      sha: string;
      repo: {
        full_name: string;
      };
    };
  };
  repository?: {
    full_name?: string;
  };
}

export class ActionConfigurationError extends Error {}

export async function runAction({
  env = process.env,
  fetchImpl = fetch,
}: ActionRunOptions = {}): Promise<ActionRunResult> {
  const provider = readInput(env, "provider", "github-actions");
  if (provider !== "github-actions") {
    throw new ActionConfigurationError(`Unsupported provider: ${provider}`);
  }

  const format = readInput(env, "format", "markdown");
  if (format !== "markdown" && format !== "json") {
    throw new ActionConfigurationError(`Invalid format: ${format}`);
  }

  const failOn = readInput(env, "fail-on", "none") as Severity | "none";
  if (!["none", "low", "medium", "high", "critical"].includes(failOn)) {
    throw new ActionConfigurationError(`Invalid fail-on threshold: ${failOn}`);
  }

  const token = readInput(env, "github-token", env.GITHUB_TOKEN ?? "");
  if (!token) {
    throw new ActionConfigurationError(
      "Missing github-token input or GITHUB_TOKEN environment variable.",
    );
  }

  const event = await readEvent(env);
  const pullRequest = event.pull_request;
  if (!pullRequest) {
    throw new ActionConfigurationError(
      "ci-delta action requires a pull_request or pull_request_target event.",
    );
  }

  const apiUrl = env.GITHUB_API_URL ?? "https://api.github.com";
  const adapter = new GitHubActionsAdapter();
  const report = await compareSources({
    provider: adapter,
    baseSource: new GitHubApiFileSource({
      repository: parseGitHubRepository(pullRequest.base.repo.full_name),
      ref: pullRequest.base.sha,
      token,
      apiUrl,
      fetchImpl,
    }),
    headSource: new GitHubApiFileSource({
      repository: parseGitHubRepository(pullRequest.head.repo.full_name),
      ref: pullRequest.head.sha,
      token,
      apiUrl,
      fetchImpl,
    }),
    baseRef: pullRequest.base.sha,
    headRef: pullRequest.head.sha,
  });

  const markdown = reportToMarkdown(report);
  const output = format === "json" ? reportToJson(report) : markdown;

  await writeStepSummary(env, markdown);

  if (parseBoolean(readInput(env, "comment", "true"))) {
    const targetRepository = parseGitHubRepository(
      event.repository?.full_name ?? pullRequest.base.repo.full_name,
    );
    await upsertStickyComment({
      apiUrl,
      token,
      repository: targetRepository,
      issueNumber: pullRequest.number,
      body: `${stickyCommentMarker}\n${markdown}`,
      fetchImpl,
    });
  }

  return {
    report,
    markdown,
    output,
    failed: meetsThreshold(report.findings, failOn),
  };
}

export async function upsertStickyComment(params: {
  apiUrl: string;
  token: string;
  repository: {
    owner: string;
    repo: string;
  };
  issueNumber: number;
  body: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const apiUrl = params.apiUrl.replace(/\/$/, "");
  const commentsPath = `/repos/${params.repository.owner}/${params.repository.repo}/issues/${params.issueNumber}/comments`;
  const comments = await githubRequest<Array<{ id: number; body?: string }>>({
    apiUrl,
    path: `${commentsPath}?per_page=100`,
    token: params.token,
    fetchImpl,
  });
  const existing = comments.find((comment) =>
    comment.body?.includes(stickyCommentMarker),
  );

  if (existing) {
    await githubRequest({
      apiUrl,
      path: `/repos/${params.repository.owner}/${params.repository.repo}/issues/comments/${existing.id}`,
      token: params.token,
      fetchImpl,
      method: "PATCH",
      body: { body: params.body },
    });
    return;
  }

  await githubRequest({
    apiUrl,
    path: commentsPath,
    token: params.token,
    fetchImpl,
    method: "POST",
    body: { body: params.body },
  });
}

async function githubRequest<T = unknown>(params: {
  apiUrl: string;
  path: string;
  token: string;
  fetchImpl: typeof fetch;
  method?: string;
  body?: unknown;
}): Promise<T> {
  const response = await params.fetchImpl(`${params.apiUrl}${params.path}`, {
    method: params.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${params.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: params.body ? JSON.stringify(params.body) : undefined,
  });

  if (!response.ok) {
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function readEvent(env: NodeJS.ProcessEnv): Promise<PullRequestEvent> {
  if (!env.GITHUB_EVENT_PATH) {
    throw new ActionConfigurationError("Missing GITHUB_EVENT_PATH.");
  }

  return JSON.parse(
    await fs.readFile(env.GITHUB_EVENT_PATH, "utf8"),
  ) as PullRequestEvent;
}

async function writeStepSummary(
  env: NodeJS.ProcessEnv,
  markdown: string,
): Promise<void> {
  if (!env.GITHUB_STEP_SUMMARY) {
    return;
  }

  await fs.appendFile(env.GITHUB_STEP_SUMMARY, `${markdown}\n`, "utf8");
}

function readInput(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): string {
  const canonicalKey = `INPUT_${name.toUpperCase()}`;
  const underscoreKey = `INPUT_${name.replace(/-/g, "_").toUpperCase()}`;
  return env[canonicalKey] ?? env[underscoreKey] ?? fallback;
}

function parseBoolean(value: string): boolean {
  return value.toLowerCase() === "true";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAction()
    .then((result) => {
      process.stdout.write(`${result.output}\n`);
      if (result.failed) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      process.stderr.write(
        `ci-delta action error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = error instanceof ActionConfigurationError ? 2 : 3;
    });
}

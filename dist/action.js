import {
  GitHubApiFileSource,
  parseGitHubRepository
} from "./chunk-H3ZHNNIH.js";
import {
  GitHubActionsAdapter,
  compareSources,
  meetsThreshold,
  reportToJson,
  reportToMarkdown
} from "./chunk-QDXXEBL4.js";

// src/action/index.ts
import { promises as fs } from "fs";
var stickyCommentMarker = "<!-- ci-delta-report -->";
var ActionConfigurationError = class extends Error {
};
async function runAction({
  env = process.env,
  fetchImpl = fetch
} = {}) {
  const provider = readInput(env, "provider", "github-actions");
  if (provider !== "github-actions") {
    throw new ActionConfigurationError(`Unsupported provider: ${provider}`);
  }
  const format = readInput(env, "format", "markdown");
  if (format !== "markdown" && format !== "json") {
    throw new ActionConfigurationError(`Invalid format: ${format}`);
  }
  const failOn = readInput(env, "fail-on", "none");
  if (!["none", "low", "medium", "high", "critical"].includes(failOn)) {
    throw new ActionConfigurationError(`Invalid fail-on threshold: ${failOn}`);
  }
  const token = readInput(env, "github-token", env.GITHUB_TOKEN ?? "");
  if (!token) {
    throw new ActionConfigurationError(
      "Missing github-token input or GITHUB_TOKEN environment variable."
    );
  }
  const event = await readEvent(env);
  const pullRequest = event.pull_request;
  if (!pullRequest) {
    throw new ActionConfigurationError(
      "ci-delta action requires a pull_request or pull_request_target event."
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
      fetchImpl
    }),
    headSource: new GitHubApiFileSource({
      repository: parseGitHubRepository(pullRequest.head.repo.full_name),
      ref: pullRequest.head.sha,
      token,
      apiUrl,
      fetchImpl
    }),
    baseRef: pullRequest.base.sha,
    headRef: pullRequest.head.sha
  });
  const markdown = reportToMarkdown(report);
  const output = format === "json" ? reportToJson(report) : markdown;
  await writeStepSummary(env, markdown);
  if (parseBoolean(readInput(env, "comment", "true"))) {
    const targetRepository = parseGitHubRepository(
      event.repository?.full_name ?? pullRequest.base.repo.full_name
    );
    await upsertStickyComment({
      apiUrl,
      token,
      repository: targetRepository,
      issueNumber: pullRequest.number,
      body: `${stickyCommentMarker}
${markdown}`,
      fetchImpl
    });
  }
  return {
    report,
    markdown,
    output,
    failed: meetsThreshold(report.findings, failOn)
  };
}
async function upsertStickyComment(params) {
  const fetchImpl = params.fetchImpl ?? fetch;
  const apiUrl = params.apiUrl.replace(/\/$/, "");
  const commentsPath = `/repos/${params.repository.owner}/${params.repository.repo}/issues/${params.issueNumber}/comments`;
  const comments = await githubRequest({
    apiUrl,
    path: `${commentsPath}?per_page=100`,
    token: params.token,
    fetchImpl
  });
  const existing = comments.find(
    (comment) => comment.body?.includes(stickyCommentMarker)
  );
  if (existing) {
    await githubRequest({
      apiUrl,
      path: `/repos/${params.repository.owner}/${params.repository.repo}/issues/comments/${existing.id}`,
      token: params.token,
      fetchImpl,
      method: "PATCH",
      body: { body: params.body }
    });
    return;
  }
  await githubRequest({
    apiUrl,
    path: commentsPath,
    token: params.token,
    fetchImpl,
    method: "POST",
    body: { body: params.body }
  });
}
async function githubRequest(params) {
  const response = await params.fetchImpl(`${params.apiUrl}${params.path}`, {
    method: params.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${params.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: params.body ? JSON.stringify(params.body) : void 0
  });
  if (!response.ok) {
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText}`
    );
  }
  if (response.status === 204) {
    return void 0;
  }
  return await response.json();
}
async function readEvent(env) {
  if (!env.GITHUB_EVENT_PATH) {
    throw new ActionConfigurationError("Missing GITHUB_EVENT_PATH.");
  }
  return JSON.parse(
    await fs.readFile(env.GITHUB_EVENT_PATH, "utf8")
  );
}
async function writeStepSummary(env, markdown) {
  if (!env.GITHUB_STEP_SUMMARY) {
    return;
  }
  await fs.appendFile(env.GITHUB_STEP_SUMMARY, `${markdown}
`, "utf8");
}
function readInput(env, name, fallback) {
  const canonicalKey = `INPUT_${name.toUpperCase()}`;
  const underscoreKey = `INPUT_${name.replace(/-/g, "_").toUpperCase()}`;
  return env[canonicalKey] ?? env[underscoreKey] ?? fallback;
}
function parseBoolean(value) {
  return value.toLowerCase() === "true";
}
if (import.meta.url === `file://${process.argv[1]}`) {
  runAction().then((result) => {
    process.stdout.write(`${result.output}
`);
    if (result.failed) {
      process.exitCode = 1;
    }
  }).catch((error) => {
    process.stderr.write(
      `ci-delta action error: ${error instanceof Error ? error.message : String(error)}
`
    );
    process.exitCode = error instanceof ActionConfigurationError ? 2 : 3;
  });
}

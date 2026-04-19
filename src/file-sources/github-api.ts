import { minimatch } from "minimatch";
import type { FileSnapshot, FileSource } from "../core/types.js";

export interface GitHubRepositoryRef {
  owner: string;
  repo: string;
}

export interface GitHubApiFileSourceOptions {
  repository: GitHubRepositoryRef;
  ref: string;
  token: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

interface GitTreeResponse {
  truncated?: boolean;
  tree: Array<{
    path?: string;
    type?: string;
    sha?: string;
  }>;
}

interface GitBlobResponse {
  content: string;
  encoding: string;
  sha?: string;
}

export class GitHubApiFileSource implements FileSource {
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private treeCache?: Map<string, string>;
  private readonly blobCache = new Map<string, FileSnapshot>();

  public constructor(private readonly options: GitHubApiFileSourceOptions) {
    this.apiUrl = (options.apiUrl ?? "https://api.github.com").replace(
      /\/$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async listFiles(globs: string[]): Promise<FileSnapshot[]> {
    const tree = await this.getTree();
    const paths = [...tree.keys()]
      .filter((filePath) => globs.some((glob) => minimatch(filePath, glob)))
      .sort();

    return Promise.all(paths.map((filePath) => this.readFile(filePath))).then(
      (snapshots) =>
        snapshots.filter(
          (snapshot): snapshot is FileSnapshot => snapshot !== null,
        ),
    );
  }

  public async readFile(filePath: string): Promise<FileSnapshot | null> {
    const cached = this.blobCache.get(filePath);
    if (cached) {
      return cached;
    }

    const tree = await this.getTree();
    const sha = tree.get(filePath);
    if (!sha) {
      return null;
    }

    const blob = await this.request<GitBlobResponse>(
      `/repos/${this.owner}/${this.repo}/git/blobs/${sha}`,
    );

    if (blob.encoding !== "base64") {
      throw new Error(
        `Unsupported GitHub blob encoding for ${filePath}: ${blob.encoding}`,
      );
    }

    const snapshot = {
      path: filePath,
      content: Buffer.from(blob.content.replace(/\n/g, ""), "base64").toString(
        "utf8",
      ),
      sha: blob.sha ?? sha,
    };
    this.blobCache.set(filePath, snapshot);
    return snapshot;
  }

  private async getTree(): Promise<Map<string, string>> {
    if (this.treeCache) {
      return this.treeCache;
    }

    const response = await this.request<GitTreeResponse>(
      `/repos/${this.owner}/${this.repo}/git/trees/${this.options.ref}?recursive=1`,
    );

    if (response.truncated) {
      throw new Error(
        `GitHub tree response for ${this.owner}/${this.repo}@${this.options.ref} was truncated; refusing to produce a partial CI Delta report.`,
      );
    }

    this.treeCache = new Map(
      response.tree.flatMap((entry) =>
        entry.path && entry.type === "blob" && entry.sha
          ? [[entry.path, entry.sha]]
          : [],
      ),
    );
    return this.treeCache;
  }

  private async request<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      throw new Error(
        `GitHub API request failed: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as T;
  }

  private get owner(): string {
    return this.options.repository.owner;
  }

  private get repo(): string {
    return this.options.repository.repo;
  }
}

export function parseGitHubRepository(fullName: string): GitHubRepositoryRef {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GitHub repository full name: ${fullName}`);
  }

  return { owner, repo };
}

// src/file-sources/github-api.ts
import { minimatch } from "minimatch";
var GitHubApiFileSource = class {
  constructor(options) {
    this.options = options;
    this.apiUrl = (options.apiUrl ?? "https://api.github.com").replace(
      /\/$/,
      ""
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  options;
  apiUrl;
  fetchImpl;
  treeCache;
  blobCache = /* @__PURE__ */ new Map();
  async listFiles(globs) {
    const tree = await this.getTree();
    const paths = [...tree.keys()].filter((filePath) => globs.some((glob) => minimatch(filePath, glob))).sort();
    return Promise.all(paths.map((filePath) => this.readFile(filePath))).then(
      (snapshots) => snapshots.filter(
        (snapshot) => snapshot !== null
      )
    );
  }
  async readFile(filePath) {
    const cached = this.blobCache.get(filePath);
    if (cached) {
      return cached;
    }
    const tree = await this.getTree();
    const sha = tree.get(filePath);
    if (!sha) {
      return null;
    }
    const blob = await this.request(
      `/repos/${this.owner}/${this.repo}/git/blobs/${sha}`
    );
    if (blob.encoding !== "base64") {
      throw new Error(
        `Unsupported GitHub blob encoding for ${filePath}: ${blob.encoding}`
      );
    }
    const snapshot = {
      path: filePath,
      content: Buffer.from(blob.content.replace(/\n/g, ""), "base64").toString(
        "utf8"
      ),
      sha: blob.sha ?? sha
    };
    this.blobCache.set(filePath, snapshot);
    return snapshot;
  }
  async getTree() {
    if (this.treeCache) {
      return this.treeCache;
    }
    const response = await this.request(
      `/repos/${this.owner}/${this.repo}/git/trees/${this.options.ref}?recursive=1`
    );
    if (response.truncated) {
      throw new Error(
        `GitHub tree response for ${this.owner}/${this.repo}@${this.options.ref} was truncated; refusing to produce a partial CI Delta report.`
      );
    }
    this.treeCache = new Map(
      response.tree.flatMap(
        (entry) => entry.path && entry.type === "blob" && entry.sha ? [[entry.path, entry.sha]] : []
      )
    );
    return this.treeCache;
  }
  async request(path) {
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.options.token}`,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    if (!response.ok) {
      throw new Error(
        `GitHub API request failed: ${response.status} ${response.statusText}`
      );
    }
    return await response.json();
  }
  get owner() {
    return this.options.repository.owner;
  }
  get repo() {
    return this.options.repository.repo;
  }
};
function parseGitHubRepository(fullName) {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GitHub repository full name: ${fullName}`);
  }
  return { owner, repo };
}

export {
  GitHubApiFileSource,
  parseGitHubRepository
};

// src/file-sources/local-git.ts
import { execFile } from "child_process";
import { promisify } from "util";
import { minimatch } from "minimatch";
var execFileAsync = promisify(execFile);
var LocalGitFileSource = class {
  constructor(repoRoot, ref) {
    this.repoRoot = repoRoot;
    this.ref = ref;
  }
  repoRoot;
  ref;
  async listFiles(globs) {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-tree", "-r", "--name-only", this.ref],
      {
        cwd: this.repoRoot
      }
    );
    const files = stdout.split("\n").map((line) => line.trim()).filter(Boolean).filter((path) => globs.some((glob) => minimatch(path, glob)));
    return Promise.all(files.map(async (path) => this.readFile(path))).then(
      (snapshots) => snapshots.filter(
        (snapshot) => snapshot !== null
      )
    );
  }
  async readFile(path) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["show", `${this.ref}:${path}`],
        {
          cwd: this.repoRoot
        }
      );
      return {
        path,
        content: stdout
      };
    } catch {
      return null;
    }
  }
};

export {
  LocalGitFileSource
};

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { minimatch } from "minimatch";
import type { FileSnapshot } from "../core/types.js";

const execFileAsync = promisify(execFile);

export class LocalGitFileSource {
  public constructor(
    private readonly repoRoot: string,
    private readonly ref: string,
  ) {}

  public async listFiles(globs: string[]): Promise<FileSnapshot[]> {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-tree", "-r", "--name-only", this.ref],
      {
        cwd: this.repoRoot,
      },
    );

    const files = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((path) => globs.some((glob) => minimatch(path, glob)));

    return Promise.all(files.map(async (path) => this.readFile(path))).then(
      (snapshots) =>
        snapshots.filter(
          (snapshot): snapshot is FileSnapshot => snapshot !== null,
        ),
    );
  }

  public async readFile(path: string): Promise<FileSnapshot | null> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["show", `${this.ref}:${path}`],
        {
          cwd: this.repoRoot,
        },
      );

      return {
        path,
        content: stdout,
      };
    } catch {
      return null;
    }
  }
}

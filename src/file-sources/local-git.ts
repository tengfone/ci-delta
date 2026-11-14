import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { minimatch } from "minimatch";
import type { FileSnapshot, FileSource } from "../core/types.js";

const execFileAsync = promisify(execFile);

const maxBuffer = 64 * 1024 * 1024;

export class LocalGitFileSource implements FileSource {
  private pathsCache?: Promise<string[]>;

  public constructor(
    private readonly repoRoot: string,
    private readonly ref: string,
  ) {}

  public listPaths(): Promise<string[]> {
    this.pathsCache ??= execFileAsync(
      "git",
      ["ls-tree", "-r", "-z", "--name-only", this.ref],
      { cwd: this.repoRoot, maxBuffer },
    ).then(({ stdout }) => stdout.split("\0").filter(Boolean));
    return this.pathsCache;
  }

  public async listFiles(globs: string[]): Promise<FileSnapshot[]> {
    const files = (await this.listPaths()).filter((path) =>
      globs.some((glob) => minimatch(path, glob)),
    );

    return Promise.all(files.map(async (path) => this.readFile(path))).then(
      (snapshots) =>
        snapshots.filter(
          (snapshot): snapshot is FileSnapshot => snapshot !== null,
        ),
    );
  }

  public async readFile(path: string): Promise<FileSnapshot | null> {
    try {
      // `git cat-file blob` fails for directories and missing paths, unlike
      // `git show`, which prints a tree listing for a directory.
      const { stdout } = await execFileAsync(
        "git",
        ["cat-file", "blob", `${this.ref}:${path}`],
        { cwd: this.repoRoot, maxBuffer },
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

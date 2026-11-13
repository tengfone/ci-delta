import type {
  FileSnapshot,
  FileSource,
  Finding,
  ProviderAdapter,
} from "../../core/types.js";
import { diffConfigs } from "./diff.js";
import {
  invalidCiFile,
  localIncludePaths,
  normalizeCiFile,
  parseYamlRoot,
  type GitLabCiFile,
} from "./normalize.js";

export type { GitLabCiFile };

export interface GitLabCiSnapshot {
  files: GitLabCiFile[];
  parseFindings: Finding[];
}

export class GitLabCiAdapter implements ProviderAdapter<GitLabCiSnapshot> {
  public readonly id = "gitlab-ci";

  public readonly displayName = "GitLab CI";

  public readonly workflowGlobs = [".gitlab-ci.yml", ".gitlab-ci.yaml"];

  public async expandFiles(
    source: FileSource,
    files: FileSnapshot[],
  ): Promise<FileSnapshot[]> {
    const byPath = new Map(files.map((file) => [file.path, file]));
    const pending = [...files];
    const attempted = new Set<string>();

    while (pending.length > 0) {
      const file = pending.shift();
      if (!file) {
        break;
      }

      for (const includePath of localIncludePaths(file.content)) {
        if (byPath.has(includePath) || attempted.has(includePath)) {
          continue;
        }

        attempted.add(includePath);
        const extra = await source.readFile(includePath);
        if (!extra) {
          continue;
        }

        byPath.set(extra.path, extra);
        pending.push(extra);
      }
    }

    return [...byPath.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
  }

  public async parse(files: FileSnapshot[]): Promise<GitLabCiSnapshot> {
    const available = new Set(files.map((file) => file.path));
    const parsed: GitLabCiFile[] = [];
    const parseFindings: Finding[] = [];

    for (const file of [...files].sort((left, right) =>
      left.path.localeCompare(right.path),
    )) {
      const doc = parseYamlRoot(file.content);
      if (!doc.root) {
        parseFindings.push({
          id: "ci-file-parse-error",
          title: "CI file parse error",
          severity: "high",
          category: "config",
          file: file.path,
          evidence: doc.errors,
          recommendation:
            "Fix invalid CI YAML before relying on CI Delta results.",
        });
        parsed.push(invalidCiFile(file.path, file.content));
        continue;
      }

      parsed.push(
        normalizeCiFile(file.path, file.content, doc.root, available),
      );
    }

    return { files: parsed, parseFindings };
  }

  public async diff(
    base: GitLabCiSnapshot,
    head: GitLabCiSnapshot,
  ): Promise<Finding[]> {
    return [
      ...base.parseFindings,
      ...head.parseFindings,
      ...diffConfigs(base.files, head.files),
    ];
  }
}

import { parseDocument } from "yaml";
import type {
  FileSnapshot,
  Finding,
  ProviderAdapter,
} from "../../core/types.js";

export interface GitHubActionsWorkflow {
  path: string;
  raw: string;
  parsed: unknown;
  name?: string;
}

export interface GitHubActionsSnapshot {
  workflows: GitHubActionsWorkflow[];
  parseFindings: Finding[];
}

export class GitHubActionsAdapter implements ProviderAdapter<GitHubActionsSnapshot> {
  public readonly id = "github-actions";

  public readonly displayName = "GitHub Actions";

  public readonly workflowGlobs = [
    ".github/workflows/*.yml",
    ".github/workflows/*.yaml",
  ];

  public async parse(files: FileSnapshot[]): Promise<GitHubActionsSnapshot> {
    const workflows: GitHubActionsWorkflow[] = [];
    const parseFindings: Finding[] = [];

    for (const file of files) {
      const doc = parseDocument(file.content);

      if (doc.errors.length > 0) {
        parseFindings.push({
          id: "workflow-parse-error",
          title: "Workflow parse error",
          severity: "high",
          category: "config",
          file: file.path,
          evidence: doc.errors.map((err) => err.message),
          recommendation:
            "Fix invalid workflow syntax before relying on CI Delta results.",
        });
        continue;
      }

      const parsed = doc.toJSON() as Record<string, unknown>;

      workflows.push({
        path: file.path,
        raw: file.content,
        parsed,
        name: typeof parsed.name === "string" ? parsed.name : undefined,
      });
    }

    return { workflows, parseFindings };
  }

  public async diff(
    base: GitHubActionsSnapshot,
    head: GitHubActionsSnapshot,
  ): Promise<Finding[]> {
    const findings: Finding[] = [];
    findings.push(...base.parseFindings, ...head.parseFindings);

    const basePaths = new Set(base.workflows.map((workflow) => workflow.path));
    const headPaths = new Set(head.workflows.map((workflow) => workflow.path));

    for (const path of headPaths) {
      if (!basePaths.has(path)) {
        findings.push({
          id: "workflow-added",
          title: "Workflow file added",
          severity: "medium",
          category: "config",
          file: path,
          evidence: [`New workflow file detected: ${path}`],
          recommendation:
            "Review new workflow triggers and permissions before merge.",
        });
      }
    }

    for (const path of basePaths) {
      if (!headPaths.has(path)) {
        findings.push({
          id: "workflow-removed",
          title: "Workflow file removed",
          severity: "medium",
          category: "config",
          file: path,
          evidence: [`Workflow file removed: ${path}`],
          recommendation:
            "Ensure the removal is intentional and does not break required checks.",
        });
      }
    }

    return findings;
  }
}

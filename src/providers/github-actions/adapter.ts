import { parseDocument } from "yaml";
import type {
  FileSnapshot,
  Finding,
  ProviderAdapter,
} from "../../core/types.js";
import { diffWorkflows } from "./diff.js";
import { normalizeWorkflow, type GitHubActionsWorkflow } from "./normalize.js";

export type { GitHubActionsWorkflow } from "./normalize.js";

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

      workflows.push(normalizeWorkflow(file.path, file.content, doc.toJSON()));
    }

    return { workflows, parseFindings };
  }

  public async diff(
    base: GitHubActionsSnapshot,
    head: GitHubActionsSnapshot,
  ): Promise<Finding[]> {
    const parseErrorPaths = new Set(
      [...base.parseFindings, ...head.parseFindings].map(
        (finding) => finding.file,
      ),
    );

    return [
      ...base.parseFindings,
      ...head.parseFindings,
      ...diffWorkflows(
        base.workflows.filter(
          (workflow) => !parseErrorPaths.has(workflow.path),
        ),
        head.workflows.filter(
          (workflow) => !parseErrorPaths.has(workflow.path),
        ),
      ),
    ];
  }
}

import { describe, expect, it } from "vitest";
import type { FileSource } from "../src/core/types.js";
import { resolveProviderId } from "../src/cli/providers.js";
import { GitLabCiAdapter } from "../src/providers/gitlab-ci/adapter.js";

const adapter = new GitLabCiAdapter();

describe("GitLab CI provider", () => {
  it("uses the gitlab-ci id and root config globs", () => {
    expect(adapter.id).toBe("gitlab-ci");
    expect(adapter.displayName).toBe("GitLab CI");
    expect(adapter.workflowGlobs).toEqual([
      ".gitlab-ci.yml",
      ".gitlab-ci.yaml",
    ]);
  });

  it("resolves gitlab provider aliases", () => {
    expect(resolveProviderId("gitlab-ci")).toBe("gitlab-ci");
    expect(resolveProviderId("gitlab")).toBe("gitlab-ci");
    expect(resolveProviderId("github-actions")).toBe("github-actions");
    expect(resolveProviderId("gha")).toBe("github-actions");
    expect(resolveProviderId("github")).toBe("github-actions");
    expect(resolveProviderId("circleci")).toBeNull();
  });

  it("loads a local include and does not fetch a remote include", async () => {
    const reads: string[] = [];
    const source: FileSource = {
      async listFiles() {
        return [];
      },
      async readFile(filePath: string) {
        reads.push(filePath);
        if (filePath.startsWith("http")) {
          throw new Error(`fetched remote include: ${filePath}`);
        }
        if (filePath === "ci/build.yml") {
          return {
            path: filePath,
            content: "build:\n  script:\n    - echo ok\n",
          };
        }
        return null;
      },
    };

    const expanded = await adapter.expandFiles(source, [
      {
        path: ".gitlab-ci.yml",
        content: [
          "include:",
          "  - local: /ci/build.yml",
          "  - remote: https://example.com/ci.yml",
          "test:",
          "  script:",
          "    - echo root",
          "",
        ].join("\n"),
      },
    ]);

    expect(reads).toEqual(["ci/build.yml"]);
    expect(expanded.map((file) => file.path).sort()).toEqual([
      ".gitlab-ci.yml",
      "ci/build.yml",
    ]);
  });

  it("reports protected variables, secret references, services, jobs, and rule removal", async () => {
    const findings = await diffYaml(
      {
        ".gitlab-ci.yml": `
variables:
  TOKEN: plain
workflow:
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
default:
  tags:
    - docker
build:
  services:
    - name: postgres:16
      alias: db
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
  script:
    - echo build
package:
  script:
    - echo pack
`,
      },
      {
        ".gitlab-ci.yml": `
variables:
  TOKEN:
    value: plain
    protected: true
  REGISTRY_PASSWORD: $CI_REGISTRY_PASSWORD
workflow:
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
    - when: always
default:
  tags:
    - kubernetes
build:
  services:
    - name: postgres:17
      alias: db
  script:
    - echo $CI_JOB_TOKEN
deploy:
  script:
    - echo deploy
`,
      },
    );

    expect(findingIds(findings).sort()).toEqual(
      [
        "job-added",
        "job-removed",
        "job-rules-removed",
        "protected-secret-reference-added",
        "protected-secret-reference-added",
        "protected-variable-added",
        "runner-tags-changed",
        "service-image-changed",
        "workflow-rules-widened",
      ].sort(),
    );

    const secretEvidence = findings
      .filter((finding) => finding.id === "protected-secret-reference-added")
      .flatMap((finding) => finding.evidence);
    expect(secretEvidence.join("\n")).toContain("$CI_JOB_TOKEN");
    expect(secretEvidence.join("\n")).toContain("$CI_REGISTRY_PASSWORD");
    expect(findings.find((finding) => finding.id === "job-added")?.job).toBe(
      "deploy",
    );
    expect(findings.find((finding) => finding.id === "job-removed")?.job).toBe(
      "package",
    );
    expect(
      findings
        .find((finding) => finding.id === "protected-variable-added")
        ?.evidence.join("\n"),
    ).toContain("protected: true");
  });

  it("does not report an unchanged secret reference or an existing id_token", async () => {
    const findings = await diffYaml(
      {
        ".gitlab-ci.yml": `
build:
  id_tokens:
    GITLAB_OIDC_TOKEN:
      aud: https://example.com
  script:
    - echo $CI_JOB_TOKEN
`,
      },
      {
        ".gitlab-ci.yml": `
build:
  id_tokens:
    GITLAB_OIDC_TOKEN:
      aud: https://example.com
  script:
    - echo $CI_JOB_TOKEN
    - echo done
`,
      },
    );

    expect(findings).toEqual([]);
  });

  it("reports an image declared as a name map and tags added from none", async () => {
    const findings = await diffYaml(
      {
        ".gitlab-ci.yml": `
build:
  image:
    name: node:20
  script:
    - npm test
`,
      },
      {
        ".gitlab-ci.yml": `
build:
  image:
    name: node:22
  tags:
    - linux
  script:
    - npm test
`,
      },
    );

    expect(findingIds(findings).sort()).toEqual(
      ["image-changed", "runner-tags-added"].sort(),
    );
    expect(
      findings
        .find((finding) => finding.id === "image-changed")
        ?.evidence.join("\n"),
    ).toContain("node:22");
  });

  it("reports added and removed CI files, removed runner tags, and a dropped changes guard", async () => {
    const findings = await diffYaml(
      {
        ".gitlab-ci.yml": `
build:
  tags:
    - docker
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
      changes:
        - src/**
  script:
    - echo build
`,
        "ci/old.yml": `
old:
  script:
    - echo old
`,
      },
      {
        ".gitlab-ci.yml": `
build:
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
  script:
    - echo build
`,
        "ci/new.yml": `
new:
  script:
    - echo new
`,
      },
    );

    expect(findingIds(findings).sort()).toEqual(
      [
        "ci-file-added",
        "ci-file-removed",
        "job-added",
        "job-rules-widened",
        "runner-tags-removed",
      ].sort(),
    );
    expect(
      findings.find((finding) => finding.id === "ci-file-added")?.file,
    ).toBe("ci/new.yml");
    expect(
      findings.find((finding) => finding.id === "ci-file-removed")?.file,
    ).toBe("ci/old.yml");
    expect(
      findings
        .find((finding) => finding.id === "job-rules-widened")
        ?.evidence.join("\n"),
    ).toContain("changes");
  });
});

async function diffYaml(
  base: Record<string, string>,
  head: Record<string, string>,
) {
  const toFiles = (files: Record<string, string>) =>
    Object.entries(files).map(([path, content]) => ({ path, content }));
  const baseSnapshot = await adapter.parse(toFiles(base));
  const headSnapshot = await adapter.parse(toFiles(head));
  return adapter.diff(baseSnapshot, headSnapshot);
}

function findingIds(findings: Array<{ id: string }>): string[] {
  return findings.map((finding) => finding.id);
}

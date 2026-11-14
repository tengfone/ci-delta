import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { minimatch } from "minimatch";
import { resolveProviderId } from "../src/cli/providers.js";
import type { FileSnapshot, FileSource, Finding } from "../src/core/types.js";
import { LocalGitFileSource } from "../src/file-sources/local-git.js";
import { GitLabCiAdapter } from "../src/providers/gitlab-ci/adapter.js";
import {
  matchLocalInclude,
  extractIncludes,
  wildcardToRegExp,
} from "../src/providers/gitlab-ci/includes.js";
import { normalizePipeline } from "../src/providers/gitlab-ci/normalize.js";
import { resolvePipeline } from "../src/providers/gitlab-ci/resolve.js";
import { compareIf, compareRules } from "../src/providers/gitlab-ci/rules.js";
import { normalizeRules } from "../src/providers/gitlab-ci/normalize.js";
import {
  isSecretLikeName,
  secretRefMatches,
} from "../src/providers/gitlab-ci/secrets.js";
import { parseGitLabYaml } from "../src/providers/gitlab-ci/yaml.js";

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
});

describe("GitLab CI YAML parsing", () => {
  it("applies merge keys and keeps !reference markers", () => {
    const { root, errors } = parseGitLabYaml(`
.base: &base
  tags: [trusted]
  script: [echo base]
job:
  <<: *base
  script: [echo job]
  rules: !reference [.rules, main]
`);
    expect(errors).toEqual([]);
    expect(root?.job).toMatchObject({
      tags: ["trusted"],
      script: ["echo job"],
    });
    expect(String((root?.job as Record<string, unknown>).rules)).toBe(
      "!reference [.rules, main]",
    );
  });

  it("skips a spec header document", () => {
    const { root, errors } = parseGitLabYaml(
      "spec:\n  inputs:\n    stage: {}\n---\nbuild:\n  script: make\n",
    );
    expect(errors).toEqual([]);
    expect(Object.keys(root ?? {})).toEqual(["build"]);
  });

  it("reports a non-mapping top level instead of treating it as empty", () => {
    expect(parseGitLabYaml("- build\n- test\n").errors[0]).toContain(
      "must be a mapping",
    );
    expect(parseGitLabYaml("just a string\n").errors[0]).toContain(
      "must be a mapping",
    );
    expect(parseGitLabYaml("").root).toEqual({});
  });

  it("keeps the last value for duplicate keys like GitLab", () => {
    const { root, errors } = parseGitLabYaml(
      "build:\n  script: one\nbuild:\n  script: two\n",
    );
    expect(errors).toEqual([]);
    expect(root?.build).toEqual({ script: "two" });
  });
});

describe("GitLab CI effective configuration", () => {
  it("resolves multi-level and list extends with GitLab merge semantics", () => {
    const pipeline = pipelineFor({
      ".gitlab-ci.yml": `
.base:
  variables:
    A: base
    B: base
  tags: [base]
  rules:
    - if: $CI_COMMIT_TAG
.middle:
  extends: .base
  variables:
    B: middle
  tags: [middle]
.other:
  image: node:22
  rules:
    - when: manual
job:
  extends: [.middle, .other]
  variables:
    C: job
  script: make
`,
    });

    const job = pipeline.jobs.job;
    expect(job?.variables).toEqual([
      { name: "A", valueText: "base" },
      { name: "B", valueText: "middle" },
      { name: "C", valueText: "job" },
    ]);
    expect(job?.tags).toEqual(["middle"]);
    expect(job?.image).toBe("node:22");
    expect(job?.rules?.map((rule) => rule.when)).toEqual(["manual"]);
    expect(job?.extends).toEqual([".middle", ".other"]);
  });

  it("does not treat hidden keys or global keywords as jobs", () => {
    const pipeline = pipelineFor({
      ".gitlab-ci.yml": `
stages: [build]
variables:
  A: "1"
.hidden:
  script: echo
build:
  stage: build
  script: make
`,
    });
    expect(Object.keys(pipeline.jobs)).toEqual(["build"]);
  });

  it("resolves !reference across included files, after extends", () => {
    const pipeline = pipelineFor({
      ".gitlab-ci.yml": `
include: ci/shared.yml
deploy:
  extends: .deploy_template
  rules:
    - !reference [.shared_rules, rules]
    - when: never
  script:
    - !reference [.setup, script]
    - ./deploy.sh
`,
      "ci/shared.yml": `
.shared_rules:
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
.setup:
  script:
    - echo setup
.deploy_template:
  environment: production
`,
    });

    const deploy = pipeline.jobs.deploy;
    expect(deploy?.rules?.map((rule) => rule.ifClause ?? rule.when)).toEqual([
      '$CI_COMMIT_BRANCH == "main"',
      "never",
    ]);
    expect(deploy?.scripts.map((script) => script.text)).toEqual([
      "echo setup",
      "./deploy.sh",
    ]);
    expect(deploy?.environment?.name).toBe("production");
    expect(deploy?.file).toBe(".gitlab-ci.yml");
  });

  it("lets the including file override included jobs and later includes win", () => {
    const pipeline = pipelineFor({
      ".gitlab-ci.yml": `
include:
  - local: ci/a.yml
  - local: ci/b.yml
deploy:
  rules:
    - when: manual
`,
      "ci/a.yml": `
deploy:
  image: node:20
  script: ./deploy.sh
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
`,
      "ci/b.yml": `
deploy:
  image: node:22
`,
    });

    const deploy = pipeline.jobs.deploy;
    expect(deploy?.image).toBe("node:22");
    expect(deploy?.scripts.map((script) => script.text)).toEqual([
      "./deploy.sh",
    ]);
    expect(deploy?.rules?.map((rule) => rule.when)).toEqual(["manual"]);
    expect(pipeline.files).toEqual([".gitlab-ci.yml", "ci/a.yml", "ci/b.yml"]);
  });

  it("applies default: and legacy globals, honoring inherit", () => {
    const pipeline = pipelineFor({
      ".gitlab-ci.yml": `
image: ruby:3.3
default:
  tags: [shared]
  before_script: [echo default]
a:
  script: make
b:
  inherit:
    default: false
  script: make
c:
  inherit:
    default: [tags]
  image: alpine
  script: make
`,
    });

    expect(pipeline.jobs.a?.image).toBe("ruby:3.3");
    expect(pipeline.jobs.a?.tags).toEqual(["shared"]);
    expect([...(pipeline.jobs.a?.inherited ?? [])].sort()).toEqual([
      "before_script",
      "image",
      "tags",
    ]);
    expect(pipeline.jobs.b?.image).toBeUndefined();
    expect(pipeline.jobs.b?.tags).toBeUndefined();
    expect(pipeline.jobs.c?.image).toBe("alpine");
    expect(pipeline.jobs.c?.tags).toEqual(["shared"]);
    expect(pipeline.jobs.c?.scripts.map((script) => script.location)).toEqual([
      "script",
    ]);
  });

  it("reports unresolved extends and references", () => {
    const pipeline = pipelineFor({
      ".gitlab-ci.yml": `
a:
  extends: .missing
  script: make
b:
  script: !reference [.nope, script]
`,
    });

    expect(pipeline.problems.map((problem) => problem.kind).sort()).toEqual([
      "extends",
      "reference",
    ]);
  });
});

describe("GitLab CI includes", () => {
  it("matches GitLab wildcard semantics", () => {
    expect(wildcardToRegExp("ci/*.yml").test("ci/a.yml")).toBe(true);
    expect(wildcardToRegExp("ci/*.yml").test("ci/sub/a.yml")).toBe(false);
    expect(wildcardToRegExp("ci/**.yml").test("ci/sub/a.yml")).toBe(true);
    expect(wildcardToRegExp("ci/**/*.yml").test("ci/a.yml")).toBe(false);
    expect(wildcardToRegExp("ci/**/*.yml").test("ci/sub/a.yml")).toBe(true);
    expect(wildcardToRegExp("ci/*.{yml,yaml}").test("ci/a.yaml")).toBe(true);

    const [include] = extractIncludes({ include: "/ci/*.yml" });
    expect(include?.wildcard).toBe(true);
    expect(
      matchLocalInclude(include!, ["ci/b.yml", "ci/a.yml", "ci/readme.md"]),
    ).toEqual(["ci/a.yml", "ci/b.yml"]);
  });

  it("loads local and wildcard includes and never fetches remote ones", async () => {
    const reads: string[] = [];
    const files: Record<string, string> = {
      "ci/build.yml": "build:\n  script: make\n",
      "ci/deploy.yml": "include: ci/nested.yml\ndeploy:\n  script: deploy\n",
      "ci/nested.yml": "nested:\n  script: echo\n",
      "ci/notes.txt": "not yaml",
    };
    const source: FileSource = {
      async listFiles() {
        throw new Error("listFiles should not be needed with listPaths");
      },
      async listPaths() {
        return Object.keys(files);
      },
      async readFile(filePath: string) {
        reads.push(filePath);
        return filePath in files
          ? { path: filePath, content: files[filePath] ?? "" }
          : null;
      },
    };

    const expanded = await adapter.expandFiles(source, [
      {
        path: ".gitlab-ci.yml",
        content: [
          "include:",
          "  - local: ci/*.yml",
          "  - local: /ci/build.yml",
          "  - local: ci",
          "  - remote: https://example.com/ci.yml",
          "  - https://example.com/other.yml",
          "test:",
          "  script: echo",
          "",
        ].join("\n"),
      },
    ]);

    expect(reads.sort()).toEqual([
      "ci/build.yml",
      "ci/deploy.yml",
      "ci/nested.yml",
    ]);
    expect(expanded.map((file) => file.path)).toEqual([
      ".gitlab-ci.yml",
      "ci/build.yml",
      "ci/deploy.yml",
      "ci/nested.yml",
    ]);
  });

  it("falls back to listFiles for wildcards when the source cannot list paths", async () => {
    const globs: string[][] = [];
    const files: FileSnapshot[] = [
      { path: "ci/a.yml", content: "a:\n  script: echo\n" },
      { path: "ci/sub/b.yml", content: "b:\n  script: echo\n" },
    ];
    const source: FileSource = {
      async listFiles(patterns: string[]) {
        globs.push(patterns);
        return files.filter((file) =>
          patterns.some((pattern) => minimatch(file.path, pattern)),
        );
      },
      async readFile() {
        return null;
      },
    };

    const expanded = await adapter.expandFiles(source, [
      { path: ".gitlab-ci.yml", content: "include: ci/*.yml\n" },
    ]);
    expect(globs).toEqual([["ci/*.yml"]]);
    expect(expanded.map((file) => file.path)).toEqual([
      ".gitlab-ci.yml",
      "ci/a.yml",
    ]);
  });

  describe("with a local git repository", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "ci-delta-gitlab-"));
    afterAll(() => rmSync(repo, { recursive: true, force: true }));

    it("expands wildcards and does not read a directory as YAML", async () => {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: repo, stdio: "pipe" });
      git("init", "-q");
      git("config", "user.email", "ci-delta@example.com");
      git("config", "user.name", "ci-delta");
      mkdirSync(path.join(repo, "ci"));
      writeFileSync(
        path.join(repo, ".gitlab-ci.yml"),
        "include:\n  - local: ci/*.yml\n  - local: ci\n",
      );
      writeFileSync(
        path.join(repo, "ci", "build.yml"),
        "build:\n  script: make\n",
      );
      git("add", "-A");
      git("commit", "-qm", "init");

      const source = new LocalGitFileSource(repo, "HEAD");
      expect(await source.readFile("ci")).toBeNull();
      expect(await source.readFile("ci/*.yml")).toBeNull();

      const roots = await source.listFiles(adapter.workflowGlobs);
      const expanded = await adapter.expandFiles(source, roots);
      expect(expanded.map((file) => file.path)).toEqual([
        ".gitlab-ci.yml",
        "ci/build.yml",
      ]);

      const snapshot = await adapter.parse(expanded);
      expect(snapshot.parseFindings).toEqual([]);
      expect(snapshot.roots).toEqual([".gitlab-ci.yml"]);
    });
  });
});

describe("GitLab CI rule comparison", () => {
  const compare = (base: unknown[], head: unknown[]) =>
    compareRules({
      label: "Job `x`",
      subject: "job",
      base: normalizeRules(base),
      head: normalizeRules(head),
      baseDefaultWhen: "on_success",
      headDefaultWhen: "on_success",
    });

  it("classifies if: expression changes", () => {
    expect(compareIf('$A == "main"', "$A").kind).toBe("widened");
    expect(compareIf("$A && $B", "$A").kind).toBe("widened");
    expect(compareIf("$A", "$A || $B").kind).toBe("widened");
    expect(compareIf("$A", undefined).kind).toBe("widened");
    expect(compareIf("$A", "$A && $B").kind).toBe("narrowed");
    expect(compareIf("$A || $B", "$A").kind).toBe("narrowed");
    expect(compareIf("$A =~ /^main$/", "$A =~ /.*/").kind).toBe("changed");
    expect(compareIf('($A == "x") && $B', '$A == "x"').kind).toBe("widened");
    expect(compareIf("$MSG =~ /a||b/ && $B", "$B").kind).toBe("widened");
  });

  it("reports nothing for identical or narrowed rules", () => {
    const rules = [{ if: "$A" }, { when: "never" }];
    expect(compare(rules, rules)).toEqual({ widened: [], changed: [] });
    expect(compare([{ if: "$A" }], [{ if: "$A && $B" }])).toEqual({
      widened: [],
      changed: [],
    });
    expect(
      compare([{ if: "$A" }], [{ if: "$FORK", when: "never" }, { if: "$A" }]),
    ).toEqual({ widened: [], changed: [] });
    expect(compare([{ if: "$A" }, { if: "$B" }], [{ if: "$A" }])).toEqual({
      widened: [],
      changed: [],
    });
  });

  it("detects a rule inserted ahead of a deny rule", () => {
    const result = compare(
      [{ if: "$FORK", when: "never" }, { if: "$MAIN" }],
      [{ if: "$MR" }, { if: "$FORK", when: "never" }, { if: "$MAIN" }],
    );
    expect(result.widened.join("\n")).toContain("ahead of deny rule");
  });

  it("detects a removed or narrowed deny rule", () => {
    expect(
      compare(
        [{ if: "$FORK", when: "never" }, { when: "always" }],
        [{ when: "always" }],
      ).widened.join("\n"),
    ).toContain("removed deny rule");

    expect(
      compare(
        [{ if: "$FORK", when: "never" }, { when: "always" }],
        [{ if: "$FORK && $OTHER", when: "never" }, { when: "always" }],
      ).widened.join("\n"),
    ).toContain("deny rule's `if:` now matches fewer pipelines");
  });

  it("detects reordering that puts a runnable rule before a deny rule", () => {
    const result = compare(
      [{ if: "$FORK", when: "never" }, { when: "on_success" }],
      [{ when: "on_success" }, { if: "$FORK", when: "never" }],
    );
    expect(result.widened.join("\n")).toContain("before the deny rule");
  });

  it("detects outcome and guard widening on a modified rule", () => {
    expect(
      compare([{ if: "$A", when: "manual" }], [{ if: "$A" }]).widened[0],
    ).toContain("`when` went from `manual` to `on_success`");
    expect(
      compare([{ if: "$A", changes: ["src/**"] }], [{ if: "$A" }]).widened[0],
    ).toContain("`changes` guard was removed");
    expect(
      compare(
        [{ exists: ["Dockerfile"] }],
        [{ exists: ["Dockerfile", "docker/*"] }],
      ).widened[0],
    ).toContain("`exists` now also matches `docker/*`");
  });

  it("reports unprovable expression changes as changed, not silence", () => {
    const result = compare([{ if: "$A =~ /^v1/" }], [{ if: "$A =~ /^v/" }]);
    expect(result.widened).toEqual([]);
    expect(result.changed[0]).toContain("cannot prove");
  });

  it("ignores rules inserted after an unconditional rule", () => {
    expect(
      compare([{ when: "on_success" }], [{ when: "on_success" }, { if: "$A" }]),
    ).toEqual({ widened: [], changed: [] });
  });
});

describe("GitLab CI secret heuristics", () => {
  it("flags credential-like names and the job token, not ordinary CI variables", () => {
    for (const name of [
      "GITLAB_API_KEY",
      "DEPLOY_KEY",
      "SSH_PRIVATE_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "NPM_TOKEN",
      "DB_PASSWORD",
      "CI_JOB_TOKEN",
      "CI_REGISTRY_PASSWORD",
      "CI_REPOSITORY_URL",
    ]) {
      expect(isSecretLikeName(name), name).toBe(true);
    }

    for (const name of [
      "CI_COMMIT_BRANCH",
      "CI_COMMIT_REF_PROTECTED",
      "CACHE_KEY",
      "GPG_PUBLIC_KEY",
      "KEYBOARD",
      "BYPASS_CHECKS",
    ]) {
      expect(isSecretLikeName(name), name).toBe(false);
    }
  });

  it("marks predefined credentials and ignores escaped references", () => {
    expect(
      secretRefMatches("curl -u gitlab-ci-token:${CI_JOB_TOKEN} $$NPM_TOKEN"),
    ).toEqual([
      { name: "CI_JOB_TOKEN", display: "${CI_JOB_TOKEN}", predefined: true },
    ]);
  });
});

describe("GitLab CI diff", () => {
  it("reports secret references, literal secrets, services, jobs, and rule removal", async () => {
    const findings = await diffYaml(
      {
        ".gitlab-ci.yml": `
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
  API_TOKEN: hunter2
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
    - curl -H "PRIVATE-TOKEN: $GITLAB_API_KEY" https://gitlab.example.com
deploy:
  script:
    - echo deploy
`,
      },
    );

    expect(summarize(findings)).toEqual(
      [
        "job-added:medium:deploy",
        "job-removed:medium:package",
        "job-rules-removed:medium:build",
        "runner-tags-changed:medium",
        "secret-literal-added:high",
        "secret-reference-added:high:build",
        "secret-reference-added:medium",
        "service-image-changed:medium:build",
        "workflow-rules-widened:high",
      ].sort(),
    );

    const evidence = findings.flatMap((finding) => finding.evidence).join("\n");
    expect(evidence).toContain("$GITLAB_API_KEY");
    expect(evidence).toContain("$CI_REGISTRY_PASSWORD");
    expect(evidence).not.toContain("hunter2");
    expect(evidence).not.toContain("protected");
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

  it("grades a predefined job token in a script as medium", async () => {
    const findings = await diffYaml(
      { ".gitlab-ci.yml": "build:\n  script: make\n" },
      {
        ".gitlab-ci.yml":
          "build:\n  script:\n    - make\n    - curl -u gitlab-ci-token:$CI_JOB_TOKEN https://x\n",
      },
    );
    expect(summarize(findings)).toEqual([
      "secret-reference-added:medium:build",
    ]);
  });

  it("reports an image declared as a name map, tags added, and id_token audience changes", async () => {
    const findings = await diffYaml(
      {
        ".gitlab-ci.yml": `
build:
  image:
    name: node:20
  id_tokens:
    TOKEN:
      aud: https://one.example.com
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
  id_tokens:
    TOKEN:
      aud: https://two.example.com
  script:
    - npm test
`,
      },
    );

    expect(summarize(findings)).toEqual(
      [
        "id-token-audience-changed:high:build",
        "image-changed:medium:build",
        "runner-tags-added:medium:build",
      ].sort(),
    );
  });

  it("reports default-level changes once instead of once per inheriting job", async () => {
    const findings = await diffYaml(
      {
        ".gitlab-ci.yml":
          "default:\n  image: node:20\na:\n  script: a\nb:\n  script: b\n",
      },
      {
        ".gitlab-ci.yml":
          "default:\n  image: node:22\na:\n  script: a\nb:\n  script: b\n",
      },
    );
    expect(summarize(findings)).toEqual(["image-changed:medium"]);
    expect(findings[0]?.evidence[0]).toContain("Default image");
  });

  it("reports added and removed files with root and include roles", async () => {
    const findings = await diffYaml(
      {
        ".gitlab-ci.yml": "include: ci/old.yml\nbuild:\n  script: make\n",
        "ci/old.yml": "old:\n  script: echo old\n",
      },
      {
        ".gitlab-ci.yml": "include: ci/new.yml\nbuild:\n  script: make\n",
        "ci/new.yml": "new:\n  script: echo new\n",
        ".gitlab-ci.yaml": "other:\n  script: echo\n",
      },
    );

    expect(summarize(findings)).toEqual(
      [
        "ci-file-added:info",
        "ci-file-added:medium",
        "ci-file-removed:info",
        "job-added:low:new",
        "job-added:low:other",
        "job-removed:medium:old",
      ].sort(),
    );
    expect(
      findings.find(
        (finding) =>
          finding.id === "ci-file-added" && finding.severity === "medium",
      )?.file,
    ).toBe(".gitlab-ci.yaml");
  });

  it("reports environment removal, needs: [], allow_failure, when, resource_group, and secret changes", async () => {
    const findings = await diffYaml(
      {
        ".gitlab-ci.yml": `
test:
  stage: test
  script: make test
deploy:
  stage: deploy
  script: ./deploy.sh
  environment:
    name: production
  resource_group: production
  secrets:
    DB_PASSWORD:
      vault: prod/db/password@ops
lint:
  stage: test
  script: make lint
notify:
  stage: deploy
  script: ./notify.sh
`,
      },
      {
        ".gitlab-ci.yml": `
test:
  stage: test
  script: make test
deploy:
  stage: deploy
  needs: []
  script: ./deploy.sh
  secrets:
    DB_PASSWORD:
      vault: other/db/password@ops
lint:
  stage: test
  script: make lint
  allow_failure: true
notify:
  stage: deploy
  script: ./notify.sh
  when: always
`,
      },
    );

    expect(summarize(findings)).toEqual(
      [
        "allow-failure-enabled:medium:lint",
        "ci-secret-changed:high:deploy",
        "deployment-environment-removed:high:deploy",
        "job-dependency-removed:medium:deploy",
        "job-when-changed:low:notify",
        "possible-deploy-gate-removed:high:deploy",
        "resource-group-removed:medium:deploy",
      ].sort(),
    );
    expect(
      findings.find((finding) => finding.id === "job-dependency-removed")
        ?.evidence[1],
    ).toContain("`needs: []` (starts immediately)");
  });

  it("does not report a dependency when explicit needs are replaced by equivalent stage ordering", async () => {
    const findings = await diffYaml(
      {
        ".gitlab-ci.yml":
          "test:\n  stage: test\n  script: t\ndeploy:\n  stage: deploy\n  needs: [test]\n  script: d\n",
      },
      {
        ".gitlab-ci.yml":
          "test:\n  stage: test\n  script: t\ndeploy:\n  stage: deploy\n  script: d\n",
      },
    );
    expect(findings).toEqual([]);
  });

  it("reports manual gates removed through rules", async () => {
    const findings = await diffYaml(
      {
        ".gitlab-ci.yml": `
deploy:
  script: ./deploy.sh
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
      when: manual
`,
      },
      {
        ".gitlab-ci.yml": `
deploy:
  script: ./deploy.sh
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
`,
      },
    );

    expect(summarize(findings)).toEqual(
      [
        "job-rules-widened:high:deploy",
        "manual-gate-removed:high:deploy",
      ].sort(),
    );
  });

  it("reports a switch between only/except and rules as changed", async () => {
    const findings = await diffYaml(
      { ".gitlab-ci.yml": "lint:\n  script: x\n  only: [main]\n" },
      {
        ".gitlab-ci.yml":
          'lint:\n  script: x\n  rules:\n    - if: $CI_PIPELINE_SOURCE == "push"\n',
      },
    );
    expect(summarize(findings)).toEqual(["job-rules-changed:low:lint"]);
  });

  it("reports workflow rules removal and new conditional includes", async () => {
    const findings = await diffYaml(
      {
        ".gitlab-ci.yml":
          "workflow:\n  rules:\n    - if: $CI_COMMIT_BRANCH\nbuild:\n  script: make\n",
      },
      {
        ".gitlab-ci.yml":
          "include:\n  - local: ci/extra.yml\n    rules:\n      - if: $CI_COMMIT_TAG\nbuild:\n  script: make\n",
        "ci/extra.yml": "extra:\n  script: echo\n",
      },
    );
    expect(summarize(findings)).toEqual(
      [
        "ci-file-added:info",
        "include-rules-not-evaluated:info",
        "job-added:low:extra",
        "workflow-rules-removed:high",
      ].sort(),
    );
  });

  it("reports new unresolved extends and !reference tags", async () => {
    const findings = await diffYaml(
      { ".gitlab-ci.yml": "build:\n  script: make\n" },
      {
        ".gitlab-ci.yml":
          "build:\n  extends: .gone\n  script: make\n  rules: !reference [.rules, main]\n",
      },
    );
    expect(summarize(findings)).toEqual(
      [
        "extends-unresolved:medium:build",
        "job-extends-changed:info:build",
        "reference-unresolved:medium:build",
      ].sort(),
    );
  });

  it("does not cascade job removals from a file that no longer parses", async () => {
    const findings = await diffYaml(
      {
        ".gitlab-ci.yml": "include: ci/jobs.yml\n",
        "ci/jobs.yml": "a:\n  script: a\nb:\n  script: b\n",
      },
      {
        ".gitlab-ci.yml": "include: ci/jobs.yml\n",
        "ci/jobs.yml": "a:\n  script: [a\n",
      },
    );
    expect(summarize(findings)).toEqual(["workflow-parse-error:high"]);
    expect(findings[0]?.file).toBe("ci/jobs.yml");
  });

  it("treats a moved job as unchanged", async () => {
    const job =
      'deploy:\n  script: ./deploy.sh\n  rules:\n    - if: $CI_COMMIT_BRANCH == "main"\n';
    const findings = await diffYaml(
      { ".gitlab-ci.yml": job },
      { ".gitlab-ci.yml": "include: ci/deploy.yml\n", "ci/deploy.yml": job },
    );
    expect(summarize(findings)).toEqual(["ci-file-added:info"]);
  });
});

function pipelineFor(files: Record<string, string>) {
  const docs = new Map(
    Object.entries(files).map(([filePath, content]) => {
      const parsed = parseGitLabYaml(content);
      return [
        filePath,
        {
          path: filePath,
          raw: content,
          root: parsed.root,
          errors: parsed.errors,
        },
      ];
    }),
  );
  return normalizePipeline(resolvePipeline(".gitlab-ci.yml", docs));
}

async function diffYaml(
  base: Record<string, string>,
  head: Record<string, string>,
): Promise<Finding[]> {
  const toFiles = (files: Record<string, string>) =>
    Object.entries(files).map(([filePath, content]) => ({
      path: filePath,
      content,
    }));
  const baseSnapshot = await adapter.parse(toFiles(base));
  const headSnapshot = await adapter.parse(toFiles(head));
  return adapter.diff(baseSnapshot, headSnapshot);
}

function summarize(findings: Finding[]): string[] {
  return findings
    .map((finding) =>
      [finding.id, finding.severity, finding.job].filter(Boolean).join(":"),
    )
    .sort();
}

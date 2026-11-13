import type { Finding } from "../../core/types.js";
import {
  renderRule,
  type GitLabCiFile,
  type GitLabIdToken,
  type GitLabInclude,
  type GitLabJob,
  type GitLabRule,
  type GitLabScript,
  type GitLabService,
  type GitLabVariable,
} from "./normalize.js";

const protectedSecretName =
  /(?:^|_)(TOKEN|PASSWORD|SECRET|PRIVATE_KEY|ACCESS_KEY|JWT)(?:_|$)/;

export function diffConfigs(
  baseFiles: GitLabCiFile[],
  headFiles: GitLabCiFile[],
): Finding[] {
  const findings: Finding[] = [];
  const baseByPath = new Map(baseFiles.map((file) => [file.path, file]));
  const headByPath = new Map(headFiles.map((file) => [file.path, file]));
  const paths = [
    ...new Set([...baseByPath.keys(), ...headByPath.keys()]),
  ].sort();

  for (const filePath of paths) {
    const base = baseByPath.get(filePath);
    const head = headByPath.get(filePath);

    if (base && !head) {
      findings.push(fileRemovedFinding(base));
      continue;
    }

    if (head && !base) {
      findings.push(fileAddedFinding(head));
      if (head.valid) {
        findings.push(...diffFile(undefined, head));
      }
      continue;
    }

    if (base?.valid && head?.valid && base.raw !== head.raw) {
      findings.push(...diffFile(base, head));
    }
  }

  return findings;
}

function diffFile(
  base: GitLabCiFile | undefined,
  head: GitLabCiFile,
): Finding[] {
  return [
    ...diffIncludes(base, head),
    ...diffVariables(
      head.path,
      undefined,
      base?.variables ?? [],
      head.variables,
    ),
    ...diffRules({
      file: head.path,
      label: "Workflow",
      removedId: "workflow-rules-removed",
      widenedId: "workflow-rules-widened",
      removedTitle: "Workflow rules removed",
      widenedTitle: "Workflow rules match more broadly",
      baseRules: base?.workflowRules ?? [],
      headRules: head.workflowRules,
    }),
    ...diffImage(head.path, undefined, "Root", base?.rootImage, head.rootImage),
    ...diffServices(
      head.path,
      undefined,
      "Root",
      base?.rootServices ?? [],
      head.rootServices,
    ),
    ...diffScripts(
      head.path,
      undefined,
      "Root",
      base?.rootScripts ?? [],
      head.rootScripts,
    ),
    ...diffImage(
      head.path,
      undefined,
      "default",
      base?.defaultImage,
      head.defaultImage,
    ),
    ...diffServices(
      head.path,
      undefined,
      "default",
      base?.defaultServices ?? [],
      head.defaultServices,
    ),
    ...diffTags(
      head.path,
      undefined,
      "default",
      base?.defaultTags,
      head.defaultTags,
    ),
    ...diffIdTokens(
      head.path,
      undefined,
      "default",
      base?.defaultIdTokens ?? [],
      head.defaultIdTokens,
    ),
    ...diffScripts(
      head.path,
      undefined,
      "default",
      base?.defaultScripts ?? [],
      head.defaultScripts,
    ),
    ...diffJobs(base, head),
  ];
}

function diffJobs(
  base: GitLabCiFile | undefined,
  head: GitLabCiFile,
): Finding[] {
  const findings: Finding[] = [];
  const baseJobs = base?.jobs ?? {};
  const jobIds = [
    ...new Set([...Object.keys(baseJobs), ...Object.keys(head.jobs)]),
  ].sort();

  for (const jobId of jobIds) {
    const baseJob = baseJobs[jobId];
    const headJob = head.jobs[jobId];

    if (baseJob && !headJob) {
      findings.push({
        id: "job-removed",
        title: "CI job removed",
        severity: "medium",
        category: "workflow-graph",
        file: head.path,
        job: jobId,
        evidence: [`Job \`${jobId}\` was removed.`],
        recommendation:
          "Confirm the removed job is no longer required by pipeline gates.",
      });
      continue;
    }

    if (!headJob) {
      continue;
    }

    if (!baseJob) {
      findings.push({
        id: "job-added",
        title: "CI job added",
        severity: isDeployJob(jobId) ? "medium" : "low",
        category: "workflow-graph",
        file: head.path,
        job: jobId,
        evidence: [`Job \`${jobId}\` was added.`],
        recommendation:
          "Confirm the new job's rules, image, runner tags, and secrets are intentional.",
      });
    }

    findings.push(...diffJob(head.path, baseJob, headJob));
  }

  return findings;
}

function diffJob(
  file: string,
  base: GitLabJob | undefined,
  head: GitLabJob,
): Finding[] {
  const scope = `Job \`${head.id}\``;
  return [
    ...diffRules({
      file,
      job: head.id,
      label: scope,
      removedId: "job-rules-removed",
      widenedId: "job-rules-widened",
      removedTitle: "Job rules removed",
      widenedTitle: "Job rules match more broadly",
      baseRules: base?.rules ?? [],
      headRules: head.rules,
    }),
    ...diffVariables(file, head.id, base?.variables ?? [], head.variables),
    ...diffImage(file, head.id, scope, base?.image, head.image),
    ...diffServices(file, head.id, scope, base?.services ?? [], head.services),
    ...diffTags(file, head.id, scope, base?.tags, head.tags),
    ...diffIdTokens(file, head.id, scope, base?.idTokens ?? [], head.idTokens),
    ...diffScripts(file, head.id, scope, base?.scripts ?? [], head.scripts),
  ];
}

function diffIncludes(
  base: GitLabCiFile | undefined,
  head: GitLabCiFile,
): Finding[] {
  return head.includes
    .filter(
      (include) => !include.expanded && !wasAlreadyUnresolved(base, include),
    )
    .map((include) => includeFinding(head.path, include));
}

function wasAlreadyUnresolved(
  base: GitLabCiFile | undefined,
  include: GitLabInclude,
): boolean {
  if (!base) {
    return false;
  }

  return base.includes.some(
    (candidate) =>
      candidate.locator === include.locator && candidate.expanded === false,
  );
}

function includeFinding(file: string, include: GitLabInclude): Finding {
  return {
    id: "include-not-expanded",
    title: "CI include was not expanded",
    severity: "medium",
    category: "config",
    file,
    evidence: [`\`${include.locator}\``],
    recommendation:
      "ci-delta did not expand this include. Remote includes are not fetched, and a missing local path was not in the file snapshot. Review that configuration separately.",
  };
}

function diffRules(params: {
  file: string;
  job?: string;
  label: string;
  removedId: string;
  widenedId: string;
  removedTitle: string;
  widenedTitle: string;
  baseRules: GitLabRule[];
  headRules: GitLabRule[];
}): Finding[] {
  const gated = params.baseRules.some((rule) => rule.restrictive);
  if (gated && params.headRules.length === 0) {
    const previous = params.baseRules
      .map((rule) => `\`${renderRule(rule)}\``)
      .join(", ");
    return [
      {
        id: params.removedId,
        title: params.removedTitle,
        severity: "high",
        category: "trigger",
        file: params.file,
        job: params.job,
        before: params.baseRules.map((rule) => renderRule(rule)),
        after: [],
        evidence: [
          `${params.label} rules were removed. Previous rules: ${previous}.`,
        ],
        recommendation:
          "Removing rules drops the previous gate. Confirm the job or pipeline should run under GitLab's default rule behavior. ci-delta does not fully evaluate rule expressions.",
      },
    ];
  }

  const evidence = widenedEvidence(
    params.label,
    params.baseRules,
    params.headRules,
  );
  if (evidence.length === 0) {
    return [];
  }

  return [
    {
      id: params.widenedId,
      title: params.widenedTitle,
      severity: "high",
      category: "trigger",
      file: params.file,
      job: params.job,
      before: params.baseRules.map((rule) => renderRule(rule)),
      after: params.headRules.map((rule) => renderRule(rule)),
      evidence,
      recommendation:
        "Confirm this broader rule match is intentional. ci-delta only reports unconditional rules and removed guards; it does not fully evaluate rule expressions.",
    },
  ];
}

function widenedEvidence(
  label: string,
  baseRules: GitLabRule[],
  headRules: GitLabRule[],
): string[] {
  if (baseRules.length === 0 || headRules.length === 0) {
    return [];
  }

  const evidence: string[] = [];
  const baseHasUnconditional = baseRules.some(
    (rule) => rule.unconditionalPositive,
  );
  const addedUnconditional = headRules.filter(
    (rule) => rule.unconditionalPositive,
  );
  if (!baseHasUnconditional && addedUnconditional.length > 0) {
    const rendered = addedUnconditional
      .map((rule) => `\`${renderRule(rule)}\``)
      .join(", ");
    evidence.push(`${label} added an unconditional rule (${rendered}).`);
  }

  if (baseRules.length === headRules.length) {
    for (const [index, baseRule] of baseRules.entries()) {
      const headRule = headRules[index];
      if (!headRule) {
        continue;
      }

      const baseGuarded = hasGuard(baseRule);
      const headGuarded = hasGuard(headRule);
      if (
        baseGuarded &&
        !headGuarded &&
        headRule.when !== "never" &&
        baseRule.when === headRule.when
      ) {
        evidence.push(
          `${label} removed the guard from rule ${index + 1} (\`${renderRule(baseRule)}\` -> \`${renderRule(headRule)}\`).`,
        );
      }

      if (
        headGuarded &&
        baseRule.hasChanges &&
        !headRule.hasChanges &&
        baseRule.ifClause === headRule.ifClause &&
        baseRule.when === headRule.when &&
        sameStrings(baseRule.exists, headRule.exists)
      ) {
        evidence.push(
          `${label} removed the \`changes\` guard from rule ${index + 1} (\`${renderRule(baseRule)}\`).`,
        );
      }

      if (
        headGuarded &&
        baseRule.exists.length > 0 &&
        headRule.exists.length === 0 &&
        baseRule.ifClause === headRule.ifClause &&
        baseRule.when === headRule.when &&
        baseRule.hasChanges === headRule.hasChanges
      ) {
        evidence.push(
          `${label} removed the \`exists\` guard from rule ${index + 1} (\`${renderRule(baseRule)}\`).`,
        );
      }

      if (
        baseRule.ifClause &&
        baseRule.ifClause === headRule.ifClause &&
        baseRule.hasChanges === headRule.hasChanges &&
        sameStrings(baseRule.exists, headRule.exists) &&
        baseRule.when === "never" &&
        headRule.when !== "never"
      ) {
        const nextWhen = headRule.when
          ? `\`when: ${headRule.when}\``
          : "`when: on_success` (default)";
        evidence.push(
          `${label} rule \`if: ${baseRule.ifClause}\` changed from \`when: never\` to ${nextWhen}.`,
        );
      }
    }
  }

  return evidence;
}

function diffVariables(
  file: string,
  job: string | undefined,
  baseVariables: GitLabVariable[],
  headVariables: GitLabVariable[],
): Finding[] {
  const findings: Finding[] = [];
  const baseByName = new Map(
    baseVariables.map((variable) => [variable.name, variable]),
  );
  const scope = job ? `Job \`${job}\` variable` : "Variable";

  for (const variable of headVariables) {
    const before = baseByName.get(variable.name);
    if (variable.protected && !before?.protected) {
      findings.push({
        id: "protected-variable-added",
        title: "Protected variable added",
        severity: "high",
        category: "secret",
        file,
        job,
        evidence: [`${scope} \`${variable.name}\` is now \`protected: true\`.`],
        recommendation:
          "Confirm this protected variable is required and is only exposed on the intended protected refs.",
      });
    }

    const addedRefs = newSecretRefs(before?.valueText, variable.valueText);
    if (addedRefs.length > 0) {
      findings.push({
        id: "protected-secret-reference-added",
        title: "Protected secret reference added",
        severity: "high",
        category: "secret",
        file,
        job,
        evidence: [
          `${scope} \`${variable.name}\` newly references ${formatRefs(addedRefs)}.`,
        ],
        recommendation:
          "Confirm this new secret reference is required and is not exposed to untrusted pipelines.",
      });
    }
  }

  return findings;
}

function diffScripts(
  file: string,
  job: string | undefined,
  scope: string,
  baseScripts: GitLabScript[],
  headScripts: GitLabScript[],
): Finding[] {
  const addedRefs = newSecretRefs(
    baseScripts.map((script) => script.text).join("\n"),
    headScripts.map((script) => script.text).join("\n"),
  );
  if (addedRefs.length === 0) {
    return [];
  }

  const cited = headScripts
    .flatMap((script) => script.text.split("\n"))
    .map((line) => line.trim())
    .filter((line) => addedRefs.some((ref) => line.includes(ref)))
    .slice(0, 4);

  return [
    {
      id: "protected-secret-reference-added",
      title: "Protected secret reference added",
      severity: "high",
      category: "secret",
      file,
      job,
      evidence: [
        `${scope} script newly references ${formatRefs(addedRefs)}.`,
        ...cited.map((line) => `\`${line}\``),
      ],
      recommendation:
        "Confirm this new secret reference in the script is required. Prefer CI variables over interpolating tokens into commands when possible.",
    },
  ];
}

function diffImage(
  file: string,
  job: string | undefined,
  scope: string,
  before: string | undefined,
  after: string | undefined,
): Finding[] {
  if (before === after || (!before && !after)) {
    return [];
  }

  const evidence = imageEvidence(scope, before, after);
  const latest = after ? imageUsesLatest(after) : false;

  return [
    {
      id: "image-changed",
      title: "Image changed",
      severity: "medium",
      category: "runner",
      file,
      job,
      before,
      after,
      evidence: [evidence],
      recommendation: latest
        ? "Avoid mutable latest image tags in CI jobs."
        : "Confirm the image source and tag are trusted.",
    },
  ];
}

function diffServices(
  file: string,
  job: string | undefined,
  scope: string,
  baseServices: GitLabService[],
  headServices: GitLabService[],
): Finding[] {
  const findings: Finding[] = [];
  const used = new Set<number>();
  const unpairedBase: GitLabService[] = [];

  for (const service of baseServices) {
    const index = headServices.findIndex(
      (candidate, candidateIndex) =>
        !used.has(candidateIndex) && candidate.key === service.key,
    );
    if (index === -1) {
      unpairedBase.push(service);
      continue;
    }

    used.add(index);
    const headService = headServices[index];
    if (headService && service.image !== headService.image) {
      findings.push(serviceFinding(file, job, scope, service, headService));
    }
  }

  const unpairedHead = headServices.filter((_, index) => !used.has(index));
  const pairedRemainder =
    unpairedBase.length === 1 &&
    unpairedHead.length === 1 &&
    unpairedBase[0] &&
    unpairedHead[0];
  if (pairedRemainder && unpairedBase[0].image !== unpairedHead[0].image) {
    findings.push(
      serviceFinding(file, job, scope, unpairedBase[0], unpairedHead[0]),
    );
    return findings;
  }

  for (const service of unpairedBase) {
    findings.push(serviceFinding(file, job, scope, service, undefined));
  }
  for (const service of unpairedHead) {
    findings.push(serviceFinding(file, job, scope, undefined, service));
  }

  return findings;
}

function serviceFinding(
  file: string,
  job: string | undefined,
  scope: string,
  before: GitLabService | undefined,
  after: GitLabService | undefined,
): Finding {
  const label = after?.label ?? before?.label ?? "service";
  let detail: string;
  if (before?.image && after?.image) {
    detail = `${scope} service \`${label}\` image changed from \`${before.image}\` to \`${after.image}\`.`;
  } else if (after?.image) {
    detail = `${scope} service \`${label}\` image is now \`${after.image}\`.`;
  } else {
    detail = `${scope} service \`${label}\` image \`${before?.image ?? "unknown"}\` was removed.`;
  }

  return {
    id: "service-image-changed",
    title: "Service image changed",
    severity: "medium",
    category: "runner",
    file,
    job,
    before: before?.image,
    after: after?.image,
    evidence: [detail],
    recommendation: "Confirm the service image source and tag are trusted.",
  };
}

function diffTags(
  file: string,
  job: string | undefined,
  scope: string,
  before: string[] | undefined,
  after: string[] | undefined,
): Finding[] {
  if (before === undefined && after === undefined) {
    return [];
  }

  const baseTags = before ?? [];
  const headTags = after ?? [];
  if (sameStrings(baseTags, headTags)) {
    return [];
  }

  const removed = baseTags.length > 0 && headTags.length === 0;
  const added = baseTags.length === 0 && headTags.length > 0;
  const id = added
    ? "runner-tags-added"
    : removed
      ? "runner-tags-removed"
      : "runner-tags-changed";
  const title = added
    ? "Runner tags added"
    : removed
      ? "Runner tags removed"
      : "Runner tags changed";
  const evidence = added
    ? `${scope} tags added: ${formatList(headTags)}.`
    : removed
      ? `${scope} tags removed: ${formatList(baseTags)}.`
      : `${scope} tags changed from ${formatList(baseTags)} to ${formatList(headTags)}.`;

  return [
    {
      id,
      title,
      severity: "medium",
      category: "runner",
      file,
      job,
      before: baseTags,
      after: headTags,
      evidence: [evidence],
      recommendation:
        "Confirm the runner tags still select a trusted runner fleet.",
    },
  ];
}

function diffIdTokens(
  file: string,
  job: string | undefined,
  scope: string,
  baseTokens: GitLabIdToken[],
  headTokens: GitLabIdToken[],
): Finding[] {
  const baseNames = new Set(baseTokens.map((token) => token.name));

  return headTokens
    .filter((token) => !baseNames.has(token.name))
    .map((token) => {
      const aud = token.aud ? ` with aud \`${token.aud}\`` : "";
      return {
        id: "id-token-added",
        title: "OIDC id_token added",
        severity: "high" as const,
        category: "oidc" as const,
        file,
        job,
        evidence: [`${scope} added id_token \`${token.name}\`${aud}.`],
        recommendation:
          "Confirm the OIDC audience and downstream trust policy are limited to this project and the intended refs.",
      };
    });
}

function fileAddedFinding(file: GitLabCiFile): Finding {
  return {
    id: "ci-file-added",
    title: "CI file added",
    severity: "medium",
    category: "config",
    file: file.path,
    evidence: [`New CI file detected: ${file.path}`],
    recommendation:
      "Review the new CI file's jobs, rules, images, runner tags, and secrets before merge.",
  };
}

function fileRemovedFinding(file: GitLabCiFile): Finding {
  return {
    id: "ci-file-removed",
    title: "CI file removed",
    severity: "medium",
    category: "config",
    file: file.path,
    evidence: [`CI file removed: ${file.path}`],
    recommendation:
      "Confirm the removed CI file is no longer required by pipeline gates.",
  };
}

function imageEvidence(
  scope: string,
  before: string | undefined,
  after: string | undefined,
): string {
  if (before && after) {
    return `${scope} image changed from \`${before}\` to \`${after}\`.`;
  }

  if (after) {
    return `${scope} image is now \`${after}\`.`;
  }

  return `${scope} image \`${before ?? "unknown"}\` was removed.`;
}

function newSecretRefs(
  before: string | undefined,
  after: string | undefined,
): string[] {
  const previous = new Set(secretRefNames(before));
  const displays = new Map<string, string>();

  for (const ref of secretRefMatches(after)) {
    if (!previous.has(ref.name) && !displays.has(ref.name)) {
      displays.set(ref.name, ref.display);
    }
  }

  return [...displays.values()];
}

function secretRefNames(text: string | undefined): string[] {
  return secretRefMatches(text).map((ref) => ref.name);
}

function secretRefMatches(
  text: string | undefined,
): Array<{ name: string; display: string }> {
  if (!text) {
    return [];
  }

  const matches: Array<{ name: string; display: string }> = [];
  const secretPattern = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
  for (const match of text.matchAll(secretPattern)) {
    const name = match[1];
    if (!name || !protectedSecretName.test(name)) {
      continue;
    }

    const raw = match[0];
    const display = raw.startsWith("${") ? `\${${name}}` : `$${name}`;
    matches.push({ name, display });
  }

  return matches;
}

function formatRefs(refs: string[]): string {
  return refs.map((ref) => `\`${ref}\``).join(", ");
}

function formatList(values: string[]): string {
  if (values.length === 0) {
    return "`none`";
  }

  return values.map((value) => `\`${value}\``).join(", ");
}

function hasGuard(rule: GitLabRule): boolean {
  return Boolean(rule.ifClause) || rule.hasChanges || rule.exists.length > 0;
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((value) => right.includes(value))
  );
}

function imageUsesLatest(image: string): boolean {
  return image.endsWith(":latest") || !image.includes(":");
}

function isDeployJob(jobId: string): boolean {
  return /deploy|release|publish/i.test(jobId);
}

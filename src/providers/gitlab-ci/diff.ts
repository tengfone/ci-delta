import type { Finding, Severity } from "../../core/types.js";
import {
  formatList,
  imageUsesLatest,
  isDeployLikeName,
  isDockerInDockerImage,
  isGateJobName,
  isProductionEnvironment,
  sameStringSet,
} from "../shared.js";
import {
  renderOnlyExcept,
  renderRule,
  type GitLabEnvironment,
  type GitLabIdToken,
  type GitLabJob,
  type GitLabOnlyExcept,
  type GitLabPipeline,
  type GitLabRule,
  type GitLabScript,
  type GitLabService,
  type GitLabTrigger,
  type GitLabVariable,
} from "./normalize.js";
import { compareRules, outcomeRankOf } from "./rules.js";
import {
  newSecretRefs,
  isSecretLikeName,
  formatRefs,
  type SecretRef,
} from "./secrets.js";

const noneLabel = "`none`";

/**
 * Compares two effective GitLab pipelines (after includes, `extends`,
 * `!reference`, and `default:` have been applied) and reports behavior
 * changes. Findings point at the file that defines the changed job or keyword.
 */
export function diffPipelines(
  base: GitLabPipeline | undefined,
  head: GitLabPipeline,
): Finding[] {
  return [
    ...diffIncludes(base, head),
    ...diffProblems(base, head),
    ...diffWorkflowRules(base, head),
    ...diffStages(base, head),
    ...diffUndeclaredStages(base, head),
    ...diffVariables({
      file: head.variablesFile,
      scope: "Variable",
      base: base?.variables ?? [],
      head: head.variables,
    }),
    ...diffDefaults(base, head),
    ...diffJobs(base, head),
  ];
}

function diffIncludes(
  base: GitLabPipeline | undefined,
  head: GitLabPipeline,
): Finding[] {
  const findings: Finding[] = [];
  const baseUnexpanded = new Set(
    (base?.includes ?? [])
      .filter((record) => record.notExpandedReason)
      .map((record) => `${record.file}|${record.include.locator}`),
  );
  const baseRules = new Set(
    (base?.includes ?? []).map(
      (record) =>
        `${record.file}|${record.include.locator}|${record.include.rules.join("\n")}`,
    ),
  );

  for (const record of head.includes) {
    const key = `${record.file}|${record.include.locator}`;
    if (record.notExpandedReason && !baseUnexpanded.has(key)) {
      findings.push({
        id: "include-not-expanded",
        title: "CI include was not expanded",
        severity: "medium",
        category: "config",
        file: record.file,
        evidence: [
          `\`${record.include.locator}\``,
          `Not expanded because ${record.notExpandedReason}.`,
        ],
        recommendation:
          "ci-delta only expands local includes that exist at the same ref. Review the configuration this include brings in separately; jobs it defines are not part of this report.",
      });
    }

    if (
      record.include.rules.length > 0 &&
      !baseRules.has(`${key}|${record.include.rules.join("\n")}`)
    ) {
      findings.push({
        id: "include-rules-not-evaluated",
        title: "Conditional include was not evaluated",
        severity: "info",
        category: "config",
        file: record.file,
        evidence: [
          `\`${record.include.locator}\` has \`include:rules\`: ${formatList(record.include.rules, noneLabel)}.`,
          record.include.kind === "local" && record.matched.length > 0
            ? "ci-delta treats the include as always applied."
            : "The include itself was not expanded.",
        ],
        recommendation:
          "Confirm the include conditions match the pipelines that should receive this configuration.",
      });
    }
  }

  return findings;
}

function diffProblems(
  base: GitLabPipeline | undefined,
  head: GitLabPipeline,
): Finding[] {
  const known = new Set(
    (base?.problems ?? []).map(
      (problem) => `${problem.kind}|${problem.detail}`,
    ),
  );

  return head.problems
    .filter((problem) => !known.has(`${problem.kind}|${problem.detail}`))
    .map((problem) => {
      const meta = {
        extends: {
          id: "extends-unresolved",
          title: "Job extends could not be resolved",
        },
        reference: {
          id: "reference-unresolved",
          title: "!reference could not be resolved",
        },
        "include-cycle": {
          id: "include-cycle",
          title: "CI include cycle",
        },
      }[problem.kind];

      return {
        id: meta.id,
        title: meta.title,
        severity: "medium" as const,
        category: "config" as const,
        file: problem.file,
        job: problem.job,
        evidence: [problem.detail],
        recommendation:
          "GitLab rejects or ignores configuration it cannot resolve. Fix the reference so the effective job configuration is what you expect.",
      };
    });
}

function diffWorkflowRules(
  base: GitLabPipeline | undefined,
  head: GitLabPipeline,
): Finding[] {
  if (!base) {
    return [];
  }

  return diffRuleLists({
    file: head.workflowFile,
    label: "Workflow",
    subject: "pipeline",
    idPrefix: "workflow-rules",
    titlePrefix: "Workflow rules",
    sensitive: true,
    base: base.workflowRules,
    head: head.workflowRules,
    baseDefaultWhen: "always",
    headDefaultWhen: "always",
  });
}

function diffStages(
  base: GitLabPipeline | undefined,
  head: GitLabPipeline,
): Finding[] {
  if (!base || base.stages.join("\n") === head.stages.join("\n")) {
    return [];
  }

  const removed = base.stages.filter((stage) => !head.stages.includes(stage));
  const added = head.stages.filter((stage) => !base.stages.includes(stage));
  const evidence = [
    `Stages changed from ${formatList(base.stages)} to ${formatList(head.stages)}.`,
  ];
  if (removed.length > 0) {
    evidence.push(`Removed stages: ${formatList(removed)}.`);
  }
  if (added.length > 0) {
    evidence.push(`Added stages: ${formatList(added)}.`);
  }

  return [
    {
      id: "stages-changed",
      title: "Pipeline stages changed",
      severity: "info",
      category: "workflow-graph",
      file: head.stagesFile,
      before: base.stages,
      after: head.stages,
      evidence,
      recommendation:
        "Stage order decides which jobs wait for which. Confirm validation stages still run before deploy stages.",
    },
  ];
}

function diffDefaults(
  base: GitLabPipeline | undefined,
  head: GitLabPipeline,
): Finding[] {
  const file = head.defaults.file;
  const scope = "Default";
  return [
    ...diffImage(
      file,
      undefined,
      scope,
      base?.defaults.image,
      head.defaults.image,
    ),
    ...diffServices(
      file,
      undefined,
      scope,
      base?.defaults.services ?? [],
      head.defaults.services,
    ),
    ...diffTags(
      file,
      undefined,
      scope,
      base?.defaults.tags,
      head.defaults.tags,
    ),
    ...diffIdTokens(
      file,
      undefined,
      scope,
      base?.defaults.idTokens ?? [],
      head.defaults.idTokens,
    ),
    ...diffScripts(
      file,
      undefined,
      scope,
      base?.defaults.scripts ?? [],
      head.defaults.scripts,
    ),
  ];
}

function diffJobs(
  base: GitLabPipeline | undefined,
  head: GitLabPipeline,
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
        file: baseJob.file,
        job: jobId,
        evidence: [`Job \`${jobId}\` was removed.`],
        recommendation:
          "Confirm the removed job is no longer required by pipeline gates or merge request approval rules.",
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
        severity: isSensitiveJob(headJob) ? "medium" : "low",
        category: "workflow-graph",
        file: headJob.file,
        job: jobId,
        evidence: [`Job \`${jobId}\` was added.`],
        recommendation:
          "Confirm the new job's rules, image, runner tags, environment, and secrets are intentional.",
      });
    }

    findings.push(...diffJob(base, head, baseJob, headJob));
  }

  return findings;
}

function diffJob(
  basePipeline: GitLabPipeline | undefined,
  headPipeline: GitLabPipeline,
  base: GitLabJob | undefined,
  head: GitLabJob,
): Finding[] {
  const file = head.file;
  const scope = `Job \`${head.id}\``;
  const inheritedBoth = (key: string) =>
    head.inherited.has(key) && (!base || base.inherited.has(key));

  return [
    ...(base ? diffJobConditions(base, head) : []),
    ...(base ? diffManualGate(base, head) : []),
    ...(base ? diffWhen(base, head) : []),
    ...(base ? diffAllowFailure(base, head) : []),
    ...(base && basePipeline
      ? diffDependencies(basePipeline, headPipeline, base, head)
      : []),
    ...diffTrigger(base, head),
    ...diffEnvironment(base, head),
    ...diffResourceGroup(base, head),
    ...diffSecretsKeyword(base, head),
    ...diffVariables({
      file,
      job: head.id,
      scope: `${scope} variable`,
      base: base?.variables ?? [],
      head: head.variables,
    }),
    ...(inheritedBoth("image")
      ? []
      : diffImage(file, head.id, scope, base?.image, head.image)),
    ...(inheritedBoth("services")
      ? []
      : diffServices(
          file,
          head.id,
          scope,
          base?.services ?? [],
          head.services,
        )),
    ...(inheritedBoth("tags")
      ? []
      : diffTags(file, head.id, scope, base?.tags, head.tags)),
    ...(inheritedBoth("id_tokens")
      ? []
      : diffIdTokens(
          file,
          head.id,
          scope,
          base?.idTokens ?? [],
          head.idTokens,
        )),
    ...diffScripts(
      file,
      head.id,
      scope,
      base?.scripts ?? [],
      head.scripts.filter((script) => !script.inherited),
    ),
    ...diffExtends(base, head),
  ];
}

/** Jobs whose behavior changes deserve a higher severity. */
function isSensitiveJob(job: GitLabJob): boolean {
  return (
    isDeployLikeName(job.id) ||
    job.environment !== undefined ||
    job.secrets.length > 0 ||
    job.idTokens.length > 0 ||
    job.trigger !== undefined ||
    job.resourceGroup !== undefined
  );
}

function isProduction(environment: GitLabEnvironment | undefined): boolean {
  if (!environment) {
    return false;
  }

  if (environment.deploymentTier) {
    return environment.deploymentTier.toLowerCase() === "production";
  }

  const firstSegment = environment.name.split("/")[0] ?? environment.name;
  return (
    isProductionEnvironment(environment.name) ||
    isProductionEnvironment(firstSegment)
  );
}

function diffJobConditions(base: GitLabJob, head: GitLabJob): Finding[] {
  const sensitive = isSensitiveJob(base) || isSensitiveJob(head);
  const label = `Job \`${head.id}\``;
  const baseKind = conditionKind(base);
  const headKind = conditionKind(head);

  if (baseKind === "rules" && headKind === "rules") {
    return diffRuleLists({
      file: head.file,
      job: head.id,
      label,
      subject: "job",
      idPrefix: "job-rules",
      titlePrefix: "Job rules",
      sensitive,
      base: base.rules,
      head: head.rules,
      baseDefaultWhen: base.when ?? "on_success",
      headDefaultWhen: head.when ?? "on_success",
    });
  }

  if (baseKind === "none") {
    return [];
  }

  const before = renderConditions(base);
  const after = renderConditions(head);

  if (headKind === "none") {
    if (baseKind === "rules" && !(base.rules ?? []).some(isRestrictiveRule)) {
      return [];
    }

    return [
      conditionFinding({
        kind: "removed",
        job: head,
        sensitive,
        before,
        after,
        evidence: [
          `${label} removed its ${baseKind === "rules" ? "`rules`" : "`only`/`except`"} conditions. Previous conditions: ${formatList(before, noneLabel)}.`,
        ],
      }),
    ];
  }

  if (baseKind === "only" && headKind === "only") {
    const widened = compareOnlyExcept(label, base, head);
    return widened.length > 0
      ? [
          conditionFinding({
            kind: "widened",
            job: head,
            sensitive,
            before,
            after,
            evidence: widened,
          }),
        ]
      : [];
  }

  return [
    conditionFinding({
      kind: "changed",
      job: head,
      sensitive,
      before,
      after,
      evidence: [
        `${label} switched from ${formatList(before, noneLabel)} to ${formatList(after, noneLabel)}. ci-delta cannot prove the new conditions are narrower.`,
      ],
    }),
  ];
}

function conditionKind(job: GitLabJob): "rules" | "only" | "none" {
  if (job.rules) {
    return "rules";
  }

  return job.only || job.except ? "only" : "none";
}

function renderConditions(job: GitLabJob): string[] {
  if (job.rules) {
    return job.rules.map((rule) => renderRule(rule));
  }

  return [
    ...(job.only ? [`only: ${renderOnlyExcept(job.only)}`] : []),
    ...(job.except ? [`except: ${renderOnlyExcept(job.except)}`] : []),
  ];
}

function isRestrictiveRule(rule: GitLabRule): boolean {
  return (
    Boolean(rule.ifClause) ||
    rule.hasChanges ||
    rule.hasExists ||
    rule.when === "never"
  );
}

function compareOnlyExcept(
  label: string,
  base: GitLabJob,
  head: GitLabJob,
): string[] {
  const evidence: string[] = [];

  if (base.only && !head.only) {
    evidence.push(
      `${label} removed \`only\` (${renderOnlyExcept(base.only)}).`,
    );
  } else if (base.only && head.only) {
    for (const field of ["refs", "variables", "changes"] as const) {
      const before = base.only[field];
      const after = head.only[field];
      if (before.length > 0 && after.length === 0) {
        evidence.push(
          `${label} removed \`only:${field}\` (${formatList(before)}).`,
        );
        continue;
      }

      const added = after.filter((entry) => !before.includes(entry));
      if (before.length > 0 && added.length > 0) {
        evidence.push(
          `${label} \`only:${field}\` now also matches ${formatList(added)}.`,
        );
      }
    }

    if (base.only.kubernetes && !head.only.kubernetes) {
      evidence.push(`${label} removed \`only:kubernetes\`.`);
    }
  }

  if (base.except && !head.except) {
    evidence.push(
      `${label} removed \`except\` (${renderOnlyExcept(base.except)}).`,
    );
  } else if (base.except && head.except) {
    for (const field of ["refs", "variables", "changes"] as const) {
      const removed = exceptRemoved(base.except, head.except, field);
      if (removed.length > 0) {
        evidence.push(
          `${label} \`except:${field}\` no longer excludes ${formatList(removed)}.`,
        );
      }
    }
  }

  return evidence;
}

function exceptRemoved(
  base: GitLabOnlyExcept,
  head: GitLabOnlyExcept,
  field: "refs" | "variables" | "changes",
): string[] {
  return base[field].filter((entry) => !head[field].includes(entry));
}

function diffRuleLists(params: {
  file: string;
  job?: string;
  label: string;
  subject: string;
  idPrefix: string;
  titlePrefix: string;
  sensitive: boolean;
  base: GitLabRule[] | undefined;
  head: GitLabRule[] | undefined;
  baseDefaultWhen: string;
  headDefaultWhen: string;
}): Finding[] {
  const baseRules = params.base ?? [];
  const headRules = params.head ?? [];
  const before = baseRules.map((rule) => renderRule(rule));
  const after = headRules.map((rule) => renderRule(rule));
  const severity = (kind: "removed" | "widened" | "changed"): Severity => {
    if (kind === "changed") {
      return params.sensitive ? "medium" : "low";
    }
    return params.sensitive ? "high" : "medium";
  };
  const finding = (
    kind: "removed" | "widened" | "changed",
    evidence: string[],
  ): Finding => ({
    id: `${params.idPrefix}-${kind}`,
    title: {
      removed: `${params.titlePrefix} removed`,
      widened: `${params.titlePrefix} match more broadly`,
      changed: `${params.titlePrefix} changed`,
    }[kind],
    severity: severity(kind),
    category: "trigger",
    file: params.file,
    job: params.job,
    before,
    after,
    evidence,
    recommendation: {
      removed:
        "Removing rules drops the previous gate. Confirm the job or pipeline should run under GitLab's default behavior. ci-delta does not evaluate rule expressions.",
      widened:
        "Confirm this broader rule match is intentional, for example that it does not run in merge request pipelines from forks or on unprotected branches. ci-delta does not evaluate rule expressions.",
      changed:
        "Review the new rules by hand. ci-delta could not prove that they match the same or fewer pipelines.",
    }[kind],
  });

  if (baseRules.length === 0) {
    return [];
  }

  if (headRules.length === 0) {
    if (!baseRules.some(isRestrictiveRule)) {
      return [];
    }

    return [
      finding("removed", [
        `${params.label} rules were removed. Previous rules: ${formatList(before, noneLabel)}.`,
      ]),
    ];
  }

  const comparison = compareRules({
    label: params.label,
    subject: params.subject,
    base: baseRules,
    head: headRules,
    baseDefaultWhen: params.baseDefaultWhen,
    headDefaultWhen: params.headDefaultWhen,
  });

  if (comparison.widened.length > 0) {
    return [finding("widened", [...comparison.widened, ...comparison.changed])];
  }

  if (comparison.changed.length > 0) {
    return [finding("changed", comparison.changed)];
  }

  return [];
}

function conditionFinding(params: {
  kind: "removed" | "widened" | "changed";
  job: GitLabJob;
  sensitive: boolean;
  before: string[];
  after: string[];
  evidence: string[];
}): Finding {
  const severity: Severity =
    params.kind === "changed"
      ? params.sensitive
        ? "medium"
        : "low"
      : params.sensitive
        ? "high"
        : "medium";

  return {
    id: `job-rules-${params.kind}`,
    title: {
      removed: "Job rules removed",
      widened: "Job rules match more broadly",
      changed: "Job rules changed",
    }[params.kind],
    severity,
    category: "trigger",
    file: params.job.file,
    job: params.job.id,
    before: params.before,
    after: params.after,
    evidence: params.evidence,
    recommendation:
      params.kind === "changed"
        ? "Review the new job conditions by hand. ci-delta could not prove that they match the same or fewer pipelines."
        : "Confirm the job should run in the broader set of pipelines, for example merge request pipelines from forks or unprotected branches.",
  };
}

type ManualStatus = "all" | "some" | "none";

function manualStatus(job: GitLabJob): ManualStatus {
  if (job.rules) {
    const outcomes = job.rules
      .map((rule) => rule.when ?? job.when ?? "on_success")
      .filter((when) => when !== "never");
    const manual = outcomes.filter((when) => when === "manual").length;
    if (manual === 0) {
      return "none";
    }
    return manual === outcomes.length ? "all" : "some";
  }

  return job.when === "manual" ? "all" : "none";
}

function diffManualGate(base: GitLabJob, head: GitLabJob): Finding[] {
  const rank: Record<ManualStatus, number> = { none: 0, some: 1, all: 2 };
  const before = manualStatus(base);
  const after = manualStatus(head);
  if (rank[after] >= rank[before]) {
    return [];
  }

  const sensitive = isSensitiveJob(base) || isSensitiveJob(head);
  const describe = (job: GitLabJob, status: ManualStatus): string => {
    if (!job.rules) {
      return `\`when: ${job.when ?? "on_success"}\``;
    }
    return status === "all"
      ? "manual for every matching rule"
      : status === "some"
        ? "manual for some rules"
        : "automatic for every matching rule";
  };

  return [
    {
      id: "manual-gate-removed",
      title: "Manual approval gate removed",
      severity: sensitive ? "high" : "medium",
      category: "deployment",
      file: head.file,
      job: head.id,
      before: describe(base, before),
      after: describe(head, after),
      evidence: [
        `Job \`${head.id}\` was ${describe(base, before)} and is now ${describe(head, after)}.`,
        ...(head.environment
          ? [`The job deploys to environment \`${head.environment.name}\`.`]
          : []),
      ],
      recommendation:
        "A manual job is a human approval step. Confirm this job should now start without someone pressing play, or keep `when: manual` and use a protected environment.",
    },
  ];
}

function diffWhen(base: GitLabJob, head: GitLabJob): Finding[] {
  const before = base.when ?? "on_success";
  const after = head.when ?? "on_success";
  if (before === after || before === "manual" || after === "manual") {
    return [];
  }

  const sensitive = isSensitiveJob(base) || isSensitiveJob(head);
  const widening = outcomeRankOf(after) > outcomeRankOf(before);
  return [
    {
      id: "job-when-changed",
      title: "Job when changed",
      severity: widening && sensitive ? "medium" : "low",
      category: "workflow-graph",
      file: head.file,
      job: head.id,
      before,
      after,
      evidence: [
        `Job \`${head.id}\` changed from \`when: ${before}\` to \`when: ${after}\`.`,
        ...(after === "always"
          ? ["`when: always` runs the job even when earlier stages fail."]
          : []),
      ],
      recommendation:
        "Confirm the job should run under the new condition relative to earlier stages.",
    },
  ];
}

function diffAllowFailure(base: GitLabJob, head: GitLabJob): Finding[] {
  if (base.allowFailure !== "false" || head.allowFailure === "false") {
    return [];
  }

  const gate =
    isGateJobName(head.id) ||
    /scan|audit|check|sast|security/i.test(head.id) ||
    isSensitiveJob(head);
  return [
    {
      id: "allow-failure-enabled",
      title: "Job failures no longer block the pipeline",
      severity: gate ? "medium" : "low",
      category: "workflow-graph",
      file: head.file,
      job: head.id,
      before: "allow_failure: false",
      after:
        head.allowFailure === "exit_codes"
          ? "allow_failure: exit_codes"
          : "allow_failure: true",
      evidence: [
        `Job \`${head.id}\` changed from \`allow_failure: false\` to \`${head.allowFailure === "exit_codes" ? "allow_failure: exit_codes" : "allow_failure: true"}\`${head.allowFailure === "true" && head.when === "manual" && !head.rules ? " (the default for manual jobs)" : ""}.`,
        head.when === "manual"
          ? "A non-blocking manual job no longer holds later stages until someone runs it."
          : "A failure in this job no longer stops later stages or marks the pipeline as failed.",
      ],
      recommendation:
        "Keep validation and deploy jobs blocking unless a failure is genuinely safe to ignore.",
    },
  ];
}

function dependencies(
  pipeline: GitLabPipeline,
  job: GitLabJob,
): { names: string[]; explicit: boolean } {
  if (job.needs) {
    return { names: job.needs.map((need) => need.name), explicit: true };
  }

  const stageIndex = pipeline.stages.indexOf(job.stage);
  if (stageIndex < 0) {
    return { names: [], explicit: false };
  }

  const names = Object.values(pipeline.jobs)
    .filter((candidate) => {
      const candidateStage = pipeline.stages.indexOf(candidate.stage);
      return candidateStage >= 0 && candidateStage < stageIndex;
    })
    .map((candidate) => candidate.id)
    .sort();
  return { names, explicit: false };
}

function describeDependencies(
  pipeline: GitLabPipeline,
  job: GitLabJob,
): string {
  if (job.needs) {
    return job.needs.length === 0
      ? "`needs: []` (starts immediately)"
      : `\`needs\`: ${formatList(job.needs.map((need) => need.name))}`;
  }

  return pipeline.stages.includes(job.stage)
    ? `stage ordering (stage \`${job.stage}\`)`
    : `stage \`${job.stage}\`, which is not declared in \`stages\``;
}

function diffDependencies(
  basePipeline: GitLabPipeline,
  headPipeline: GitLabPipeline,
  base: GitLabJob,
  head: GitLabJob,
): Finding[] {
  const findings: Finding[] = [];
  const before = dependencies(basePipeline, base);
  const after = dependencies(headPipeline, head);
  const removed = before.names.filter(
    (name) =>
      !after.names.includes(name) &&
      (before.explicit || name in headPipeline.jobs),
  );

  if (removed.length > 0) {
    const evidence = [
      `Job \`${head.id}\` no longer waits for ${formatList(removed)}.`,
      `Before: ${describeDependencies(basePipeline, base)}. After: ${describeDependencies(headPipeline, head)}.`,
    ];
    findings.push({
      id: "job-dependency-removed",
      title: "Job dependency removed",
      severity: "medium",
      category: "workflow-graph",
      file: head.file,
      job: head.id,
      before: before.names,
      after: after.names,
      evidence,
      recommendation:
        "Confirm removing this dependency does not bypass validation or build gates.",
    });

    const gates = removed.filter((name) => isGateJobName(name));
    if (
      gates.length > 0 &&
      (isDeployLikeName(head.id) || head.environment !== undefined)
    ) {
      findings.push({
        id: "possible-deploy-gate-removed",
        title: "Possible deploy gate removed",
        severity: "high",
        category: "workflow-graph",
        file: head.file,
        job: head.id,
        before: before.names,
        after: after.names,
        evidence: [
          `Deploy-like job \`${head.id}\` no longer depends on ${formatList(gates)}.`,
        ],
        recommendation:
          "Keep deploy and release jobs dependent on test, lint, or build jobs unless the gate moved elsewhere.",
      });
    }
  }

  if (before.explicit && after.explicit) {
    const added = after.names.filter((name) => !before.names.includes(name));
    if (added.length > 0) {
      findings.push({
        id: "job-dependency-added",
        title: "Job dependency added",
        severity: "info",
        category: "workflow-graph",
        file: head.file,
        job: head.id,
        before: before.names,
        after: after.names,
        evidence: [`Job \`${head.id}\` now needs ${formatList(added)}.`],
        recommendation:
          "Confirm the new dependency order matches the intended pipeline graph.",
      });
    }
  }

  return findings;
}

function diffUndeclaredStages(
  base: GitLabPipeline | undefined,
  head: GitLabPipeline,
): Finding[] {
  const byFile = new Map<string, GitLabJob[]>();
  for (const job of Object.values(head.jobs)) {
    if (head.stages.includes(job.stage)) {
      continue;
    }

    const baseJob = base?.jobs[job.id];
    if (baseJob && base && !base.stages.includes(baseJob.stage)) {
      continue;
    }

    byFile.set(job.file, [...(byFile.get(job.file) ?? []), job]);
  }

  return [...byFile.entries()].map(([file, jobs]) => ({
    id: "job-stage-undefined",
    title: "Jobs use an undeclared stage",
    severity: "medium" as const,
    category: "config" as const,
    file,
    job: jobs.length === 1 ? jobs[0]?.id : undefined,
    after: jobs.map((job) => `${job.id}: ${job.stage}`),
    evidence: [
      ...jobs.map((job) => `Job \`${job.id}\` uses stage \`${job.stage}\`.`),
      `Declared stages: ${formatList(head.stages)}.`,
    ],
    recommendation:
      "GitLab rejects pipelines whose jobs use an undeclared stage. Add the stage back or move the jobs.",
  }));
}

function describeTrigger(trigger: GitLabTrigger): string {
  const parts: string[] = [];
  if (trigger.project) {
    parts.push(`project: ${trigger.project}`);
  }
  if (trigger.branch) {
    parts.push(`branch: ${trigger.branch}`);
  }
  if (trigger.include.length > 0) {
    parts.push(`include: ${trigger.include.join(", ")}`);
  }
  return parts.join("; ") || "downstream pipeline";
}

function diffTrigger(base: GitLabJob | undefined, head: GitLabJob): Finding[] {
  const before = base?.trigger;
  const after = head.trigger;
  if (!after) {
    return [];
  }

  const findings: Finding[] = [];
  const notAnalyzed =
    "ci-delta does not analyze the downstream pipeline configuration.";

  if (!before) {
    findings.push({
      id: "trigger-added",
      title: "Downstream pipeline trigger added",
      severity: "medium",
      category: "workflow-graph",
      file: head.file,
      job: head.id,
      after: describeTrigger(after),
      evidence: [
        `Job \`${head.id}\` now triggers \`${describeTrigger(after)}\`.`,
        notAnalyzed,
      ],
      recommendation:
        "Review the downstream pipeline configuration; it runs with this pipeline's context and can be a separate deploy path.",
    });
    return findings;
  }

  if (describeTrigger(before) !== describeTrigger(after)) {
    findings.push({
      id: "trigger-changed",
      title: "Downstream pipeline target changed",
      severity: "high",
      category: "workflow-graph",
      file: head.file,
      job: head.id,
      before: describeTrigger(before),
      after: describeTrigger(after),
      evidence: [
        `Job \`${head.id}\` trigger changed from \`${describeTrigger(before)}\` to \`${describeTrigger(after)}\`.`,
        notAnalyzed,
      ],
      recommendation:
        "Review the new downstream configuration or project. A changed child pipeline file swaps out every job it runs.",
    });
  }

  if (before.strategy === "depend" && after.strategy !== "depend") {
    findings.push({
      id: "trigger-strategy-removed",
      title: "Downstream pipeline no longer gates this pipeline",
      severity: "medium",
      category: "workflow-graph",
      file: head.file,
      job: head.id,
      before: "strategy: depend",
      after: after.strategy ? `strategy: ${after.strategy}` : undefined,
      evidence: [
        `Job \`${head.id}\` removed \`strategy: depend\`, so it succeeds as soon as the downstream pipeline is created.`,
      ],
      recommendation:
        "Keep `strategy: depend` when later jobs rely on the downstream pipeline passing.",
    });
  }

  return findings;
}

function describeEnvironment(environment: GitLabEnvironment): string {
  return environment.deploymentTier
    ? `${environment.name} (tier: ${environment.deploymentTier})`
    : environment.name;
}

function diffEnvironment(
  base: GitLabJob | undefined,
  head: GitLabJob,
): Finding[] {
  const before = base?.environment;
  const after = head.environment;

  if (before && !after) {
    const production = isProduction(before);
    return [
      {
        id: "deployment-environment-removed",
        title: "Deployment environment removed",
        severity: production ? "high" : "medium",
        category: "deployment",
        file: head.file,
        job: head.id,
        before: describeEnvironment(before),
        evidence: [
          `Job \`${head.id}\` no longer declares environment \`${describeEnvironment(before)}\`.`,
        ],
        recommendation:
          "Protected environment approvals, deployment tracking, and environment-scoped variables no longer apply to this job. Confirm that is intentional.",
      },
    ];
  }

  if (!after) {
    return [];
  }

  if (before && describeEnvironment(before) === describeEnvironment(after)) {
    return [];
  }

  const production = isProduction(after);
  const wasProduction = isProduction(before);
  if (production && wasProduction) {
    return [
      {
        id: "deployment-environment-changed",
        title: "Deployment environment changed",
        severity: "medium",
        category: "deployment",
        file: head.file,
        job: head.id,
        before: before ? describeEnvironment(before) : undefined,
        after: describeEnvironment(after),
        evidence: [
          `Job \`${head.id}\` environment changed from \`${before ? describeEnvironment(before) : "none"}\` to \`${describeEnvironment(after)}\`.`,
        ],
        recommendation:
          "Confirm the new production environment has the same protection rules and approvals.",
      },
    ];
  }

  return [
    {
      id: production
        ? "deployment-production-added"
        : before
          ? "deployment-environment-changed"
          : "deployment-environment-added",
      title: production
        ? "Production deployment environment added"
        : before
          ? "Deployment environment changed"
          : "Deployment environment added",
      severity:
        production && before ? "critical" : production ? "high" : "medium",
      category: "deployment",
      file: head.file,
      job: head.id,
      before: before ? describeEnvironment(before) : undefined,
      after: describeEnvironment(after),
      evidence: [
        `Job \`${head.id}\` environment changed from \`${before ? describeEnvironment(before) : "none"}\` to \`${describeEnvironment(after)}\`.`,
      ],
      recommendation: production
        ? "Confirm the production environment is protected and requires the intended approvals."
        : "Confirm this deployment environment change is intentional.",
    },
  ];
}

function diffResourceGroup(
  base: GitLabJob | undefined,
  head: GitLabJob,
): Finding[] {
  if (!base?.resourceGroup || head.resourceGroup) {
    return [];
  }

  const sensitive = isDeployLikeName(head.id) || isProduction(head.environment);
  return [
    {
      id: "resource-group-removed",
      title: "Resource group removed",
      severity: sensitive ? "medium" : "low",
      category: "deployment",
      file: head.file,
      job: head.id,
      before: base.resourceGroup,
      evidence: [
        `Job \`${head.id}\` no longer uses \`resource_group: ${base.resourceGroup}\`.`,
      ],
      recommendation:
        "Without a resource group, concurrent pipelines can run this job at the same time. Keep deploys serialized.",
    },
  ];
}

function diffSecretsKeyword(
  base: GitLabJob | undefined,
  head: GitLabJob,
): Finding[] {
  const before = new Map(
    (base?.secrets ?? []).map((secret) => [secret.name, secret.source]),
  );
  const findings: Finding[] = [];

  for (const secret of head.secrets) {
    const previous = before.get(secret.name);
    if (previous === secret.source) {
      continue;
    }

    findings.push({
      id: previous === undefined ? "ci-secret-added" : "ci-secret-changed",
      title:
        previous === undefined
          ? "External secret added"
          : "External secret source changed",
      severity: "high",
      category: "secret",
      file: head.file,
      job: head.id,
      before: previous,
      after: secret.source,
      evidence: [
        previous === undefined
          ? `Job \`${head.id}\` now reads secret \`${secret.name}\` from \`${secret.source}\`.`
          : `Job \`${head.id}\` secret \`${secret.name}\` changed from \`${previous}\` to \`${secret.source}\`.`,
      ],
      recommendation:
        "Confirm the secret is needed by this job and that the job only runs on protected refs or environments that should receive it.",
    });
  }

  return findings;
}

function diffExtends(base: GitLabJob | undefined, head: GitLabJob): Finding[] {
  if (!base || sameStringSet(base.extends, head.extends)) {
    return [];
  }

  return [
    {
      id: "job-extends-changed",
      title: "Job extends changed",
      severity: "info",
      category: "config",
      file: head.file,
      job: head.id,
      before: base.extends,
      after: head.extends,
      evidence: [
        `Job \`${head.id}\` extends changed from ${formatList(base.extends, noneLabel)} to ${formatList(head.extends, noneLabel)}.`,
        "Other findings for this job compare the fully resolved configuration.",
      ],
      recommendation:
        "Confirm the new template still provides the rules, environment, and runner settings the job relies on.",
    },
  ];
}

function diffVariables(params: {
  file: string;
  job?: string;
  scope: string;
  base: GitLabVariable[];
  head: GitLabVariable[];
}): Finding[] {
  const findings: Finding[] = [];
  const baseByName = new Map(
    params.base.map((variable) => [variable.name, variable]),
  );

  for (const variable of params.head) {
    const before = baseByName.get(variable.name);
    const addedRefs = newSecretRefs(before?.valueText, variable.valueText);
    if (addedRefs.length > 0) {
      findings.push(
        secretRefFinding({
          file: params.file,
          job: params.job,
          refs: addedRefs,
          inScript: false,
          evidence: [
            `${params.scope} \`${variable.name}\` newly references ${formatRefs(addedRefs)}.`,
          ],
        }),
      );
    }

    if (
      isSecretLikeName(variable.name) &&
      isLiteralValue(variable.valueText) &&
      (before?.valueText !== variable.valueText ||
        !isLiteralValue(before?.valueText))
    ) {
      findings.push({
        id: "secret-literal-added",
        title: "Secret-like variable has a literal value",
        severity: "high",
        category: "secret",
        file: params.file,
        job: params.job,
        evidence: [
          `${params.scope} \`${variable.name}\` is set to a literal value in the CI file (value not shown).`,
        ],
        recommendation:
          "Store credentials as masked, protected CI/CD variables or in a secrets manager instead of committing them to the repository.",
      });
    }
  }

  return findings;
}

function isLiteralValue(value: string | undefined): boolean {
  return Boolean(value?.trim()) && !/\$/.test(value ?? "");
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
    .filter((line) => addedRefs.some((ref) => line.includes(ref.display)))
    .slice(0, 4);

  return [
    secretRefFinding({
      file,
      job,
      refs: addedRefs,
      inScript: true,
      evidence: [
        `${scope} script newly references ${formatRefs(addedRefs)}.`,
        ...cited.map((line) => `\`${line}\``),
      ],
    }),
  ];
}

function secretRefFinding(params: {
  file: string;
  job?: string;
  refs: SecretRef[];
  inScript: boolean;
  evidence: string[];
}): Finding {
  const userSecrets = params.refs.some((ref) => !ref.predefined);
  const severity: Severity = params.inScript && userSecrets ? "high" : "medium";
  return {
    id: "secret-reference-added",
    title: params.inScript
      ? "Secret-like variable used in a script"
      : "Secret-like variable reference added",
    severity,
    category: "secret",
    file: params.file,
    job: params.job,
    evidence: params.evidence,
    recommendation: params.inScript
      ? "Confirm the credential is needed, is masked and protected in CI/CD settings, and is not reachable from merge request pipelines that run untrusted code. Avoid echoing it or passing it on command lines that end up in logs."
      : "Confirm the credential is needed and is not exposed to pipelines that run untrusted code.",
  };
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

  const findings: Finding[] = [
    {
      id: "image-changed",
      title: "Image changed",
      severity: "medium",
      category: "runner",
      file,
      job,
      before,
      after,
      evidence: [imageEvidence(scope, before, after)],
      recommendation:
        after && imageUsesLatest(after)
          ? "Avoid mutable latest image tags in CI jobs."
          : "Confirm the image source and tag are trusted.",
    },
  ];

  if (isDockerInDockerImage(after) && !isDockerInDockerImage(before)) {
    findings.push({
      id: "privileged-image-added",
      title: "Docker-in-Docker image added",
      severity: "high",
      category: "runner",
      file,
      job,
      after,
      evidence: [
        `${scope} now runs in \`${after}\`, which needs a privileged runner.`,
      ],
      recommendation:
        "Review privileged Docker-in-Docker use carefully; it can expand the job's access to the runner host.",
    });
  }

  return findings;
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
  const pairs: Array<[GitLabService | undefined, GitLabService | undefined]> =
    [];

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
    pairs.push([service, headServices[index]]);
  }

  const unpairedHead = headServices.filter((_, index) => !used.has(index));
  if (unpairedBase.length === 1 && unpairedHead.length === 1) {
    pairs.push([unpairedBase[0], unpairedHead[0]]);
  } else {
    pairs.push(
      ...unpairedBase.map(
        (service) => [service, undefined] as [GitLabService, undefined],
      ),
      ...unpairedHead.map(
        (service) => [undefined, service] as [undefined, GitLabService],
      ),
    );
  }

  for (const [before, after] of pairs) {
    if (before?.image === after?.image) {
      continue;
    }

    findings.push(serviceFinding(file, job, scope, before, after));
    if (
      isDockerInDockerImage(after?.image) &&
      !baseServices.some((service) => isDockerInDockerImage(service.image))
    ) {
      findings.push({
        id: "privileged-service-added",
        title: "Privileged service added",
        severity: "high",
        category: "runner",
        file,
        job,
        after: after?.image,
        evidence: [
          `${scope} service \`${after?.label ?? "service"}\` uses \`${after?.image ?? "unknown image"}\`, which needs a privileged runner.`,
        ],
        recommendation:
          "Review privileged services carefully; Docker-in-Docker can expand the job's access to the runner host.",
      });
    }
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
  const baseTags = before ?? [];
  const headTags = after ?? [];
  if (sameStringSet(baseTags, headTags)) {
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
    ? `${scope} tags added: ${formatList(headTags, noneLabel)}.`
    : removed
      ? `${scope} tags removed: ${formatList(baseTags, noneLabel)}.`
      : `${scope} tags changed from ${formatList(baseTags, noneLabel)} to ${formatList(headTags, noneLabel)}.`;

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
  const baseByName = new Map(baseTokens.map((token) => [token.name, token]));
  const findings: Finding[] = [];

  for (const token of headTokens) {
    const previous = baseByName.get(token.name);
    if (!previous) {
      const aud = token.aud ? ` with aud \`${token.aud}\`` : "";
      findings.push({
        id: "id-token-added",
        title: "OIDC id_token added",
        severity: "high",
        category: "oidc",
        file,
        job,
        after: token.aud,
        evidence: [`${scope} added id_token \`${token.name}\`${aud}.`],
        recommendation:
          "Confirm the OIDC audience and downstream trust policy are limited to this project and the intended refs.",
      });
      continue;
    }

    if (previous.aud !== token.aud) {
      findings.push({
        id: "id-token-audience-changed",
        title: "OIDC id_token audience changed",
        severity: "high",
        category: "oidc",
        file,
        job,
        before: previous.aud,
        after: token.aud,
        evidence: [
          `${scope} id_token \`${token.name}\` audience changed from \`${previous.aud ?? "none"}\` to \`${token.aud ?? "none"}\`.`,
        ],
        recommendation:
          "Confirm the new audience's trust policy is limited to this project and the intended refs.",
      });
    }
  }

  return findings;
}

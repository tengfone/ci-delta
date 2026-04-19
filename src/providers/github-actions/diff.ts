import type { Finding, Severity } from "../../core/types.js";
import {
  explicitWriteScopes,
  hasWritePermission,
  permissionAccess,
  type GitHubActionsWorkflow,
  type JsonObject,
  type NormalizedJob,
  type NormalizedPermissions,
  type NormalizedStep,
} from "./normalize.js";

const sensitiveWriteScopes = new Map<string, Severity>([
  ["contents", "high"],
  ["pull-requests", "high"],
  ["actions", "high"],
  ["checks", "high"],
  ["security-events", "high"],
  ["packages", "medium"],
]);

const secretPattern = /\bsecrets(?:\.[A-Za-z_][\w-]*|\s*\[)/;
const prHeadPatterns = [
  "github.event.pull_request.head.sha",
  "github.head_ref",
  "github.event.pull_request.head.repo.full_name",
];

export function diffWorkflows(
  baseWorkflows: GitHubActionsWorkflow[],
  headWorkflows: GitHubActionsWorkflow[],
): Finding[] {
  const findings: Finding[] = [];
  const baseByPath = byPath(baseWorkflows);
  const headByPath = byPath(headWorkflows);
  const paths = [
    ...new Set([...baseByPath.keys(), ...headByPath.keys()]),
  ].sort();

  for (const path of paths) {
    const base = baseByPath.get(path);
    const head = headByPath.get(path);

    if (!head && base) {
      findings.push(workflowRemovedFinding(base));
      continue;
    }

    if (head && !base) {
      findings.push(workflowAddedFinding(head));
      findings.push(...diffWorkflow(undefined, head));
      continue;
    }

    if (base && head && base.raw !== head.raw) {
      findings.push(...diffWorkflow(base, head));
    }
  }

  return findings;
}

function diffWorkflow(
  base: GitHubActionsWorkflow | undefined,
  head: GitHubActionsWorkflow,
): Finding[] {
  return [
    ...diffTriggerAdditions(base, head),
    ...diffTriggerChanges(base, head),
    ...diffPermissionElevations(base, head),
    ...diffSecretUsage(base, head),
    ...diffOidcCloudAuth(base, head),
    ...diffUntrustedCheckouts(base, head),
    ...diffRunnerAndExecution(base, head),
    ...diffDeploymentEnvironments(base, head),
    ...diffActionUses(base, head),
    ...diffJobGraph(base, head),
  ];
}

function diffTriggerAdditions(
  base: GitHubActionsWorkflow | undefined,
  head: GitHubActionsWorkflow,
): Finding[] {
  const findings: Finding[] = [];
  const baseEvents = new Set(Object.keys(base?.triggers ?? {}));

  for (const event of Object.keys(head.triggers).sort()) {
    if (baseEvents.has(event)) {
      continue;
    }

    const special = triggerFindingDetails(event);
    findings.push({
      id: special.id,
      title: special.title,
      severity: special.severity,
      category: "trigger",
      file: head.path,
      before: undefined,
      after: event,
      evidence: [`New trigger: \`${event}\``],
      recommendation: special.recommendation,
    });
  }

  return findings;
}

function diffTriggerChanges(
  base: GitHubActionsWorkflow | undefined,
  head: GitHubActionsWorkflow,
): Finding[] {
  const findings: Finding[] = [];
  const baseTriggers = base?.triggers ?? {};

  for (const event of Object.keys(baseTriggers).sort()) {
    if (!(event in head.triggers)) {
      findings.push({
        id: "trigger-event-removed",
        title: "Workflow trigger removed",
        severity: "low",
        category: "trigger",
        file: head.path,
        before: event,
        after: undefined,
        evidence: [`Removed trigger: \`${event}\``],
        recommendation:
          "Confirm this workflow should no longer run for the removed event.",
      });
    }
  }

  for (const [event, headTrigger] of Object.entries(head.triggers)) {
    const baseTrigger = baseTriggers[event];
    if (!baseTrigger) {
      continue;
    }

    const branchSeverity = event === "push" ? "high" : "medium";
    if (
      (event === "push" || event === "pull_request") &&
      filterWidened(baseTrigger.branches, headTrigger.branches)
    ) {
      findings.push({
        id: "trigger-filter-widened",
        title: `${event} branch filter widened`,
        severity: branchSeverity,
        category: "trigger",
        file: head.path,
        before: baseTrigger.branches,
        after: headTrigger.branches,
        evidence: [
          `\`${event}\` branch filter changed from ${formatList(baseTrigger.branches)} to ${formatList(headTrigger.branches)}.`,
        ],
        recommendation:
          "Confirm the workflow should run on the broader branch set.",
      });
    }

    if (baseTrigger.paths.length > 0 && headTrigger.paths.length === 0) {
      findings.push(pathFilterRemovedFinding(head.path, event, "paths"));
    }

    if (
      baseTrigger.pathsIgnore.length > 0 &&
      headTrigger.pathsIgnore.length === 0
    ) {
      findings.push(pathFilterRemovedFinding(head.path, event, "paths-ignore"));
    }

    if (baseTrigger.tags.length === 0 && headTrigger.tags.length > 0) {
      findings.push({
        id: "trigger-tags-added",
        title: `${event} tag trigger added`,
        severity: "medium",
        category: "trigger",
        file: head.path,
        before: [],
        after: headTrigger.tags,
        evidence: [
          `\`${event}\` tag filter added: ${formatList(headTrigger.tags)}.`,
        ],
        recommendation:
          "Confirm tag-triggered releases or deployments are intentional.",
      });
    }
  }

  return findings;
}

function diffPermissionElevations(
  base: GitHubActionsWorkflow | undefined,
  head: GitHubActionsWorkflow,
): Finding[] {
  const findings: Finding[] = [];

  findings.push(
    ...comparePermissions({
      file: head.path,
      base: base?.permissions,
      head: head.permissions,
    }),
  );

  for (const [jobId, headJob] of Object.entries(head.jobs)) {
    findings.push(
      ...comparePermissions({
        file: head.path,
        job: jobId,
        base: base?.jobs[jobId]?.permissions,
        head: headJob.permissions,
      }),
    );
  }

  return findings;
}

function comparePermissions(params: {
  file: string;
  job?: string;
  base?: NormalizedPermissions;
  head: NormalizedPermissions;
}): Finding[] {
  const findings: Finding[] = [];

  if (params.head.mode === "write-all" && params.base?.mode !== "write-all") {
    findings.push({
      id: "permission-write-all-added",
      title: "GITHUB_TOKEN write-all permission added",
      severity: "critical",
      category: "permission",
      file: params.file,
      job: params.job,
      before: params.base?.raw,
      after: params.head.raw,
      evidence: [`${permissionLocation(params.job)} now grants \`write-all\`.`],
      recommendation:
        "Replace write-all with the minimum explicit permissions needed by this workflow.",
    });
    return findings;
  }

  for (const scope of explicitWriteScopes(params.head)) {
    if (scope === "*") {
      continue;
    }

    const before = params.base ? permissionAccess(params.base, scope) : "none";
    if (before === "write") {
      continue;
    }

    findings.push(permissionWriteFinding(params, scope, before));
  }

  return findings;
}

function diffSecretUsage(
  base: GitHubActionsWorkflow | undefined,
  head: GitHubActionsWorkflow,
): Finding[] {
  const baseUsageKeys = new Set(
    collectSecretUsages(base).map((usage) => usage.key),
  );
  const added = collectSecretUsages(head).filter(
    (usage) => !baseUsageKeys.has(usage.key),
  );

  if (added.length === 0) {
    return [];
  }

  const grouped = groupBy(added, (usage) => usage.job ?? "");
  const findings: Finding[] = [];
  const hasPullRequestTarget = "pull_request_target" in head.triggers;

  for (const [job, usages] of grouped) {
    const inRun = usages.filter((usage) => usage.inRun);
    const evidence = usages
      .slice(0, 6)
      .map((usage) => `${usage.location}: \`${usage.value}\``);

    if (hasPullRequestTarget) {
      findings.push({
        id: "secret-with-pr-target",
        title: "Secret usage added to pull_request_target workflow",
        severity: "critical",
        category: "secret",
        file: head.path,
        job: job || undefined,
        evidence: [
          "Workflow is triggered by `pull_request_target`.",
          ...evidence,
        ],
        recommendation:
          "Do not expose secrets to workflows that can be influenced by untrusted pull request code.",
      });
      continue;
    }

    if (inRun.length > 0) {
      findings.push({
        id: "secret-in-run-command-added",
        title: "Secret usage added to shell command",
        severity: "high",
        category: "secret",
        file: head.path,
        job: job || undefined,
        evidence: inRun
          .slice(0, 6)
          .map((usage) => `${usage.location}: \`${usage.value}\``),
        recommendation:
          "Prefer passing secrets through scoped action inputs or environment variables instead of interpolating them into shell commands.",
      });
      continue;
    }

    findings.push({
      id: "secret-usage-added",
      title: "Secret usage added",
      severity: "medium",
      category: "secret",
      file: head.path,
      job: job || undefined,
      evidence,
      recommendation:
        "Confirm the secret is needed and is not reachable from untrusted workflow execution paths.",
    });
  }

  return findings;
}

function diffUntrustedCheckouts(
  base: GitHubActionsWorkflow | undefined,
  head: GitHubActionsWorkflow,
): Finding[] {
  const baseRisks = new Set(collectUntrustedCheckoutRisks(base).map(riskKey));

  return collectUntrustedCheckoutRisks(head)
    .filter((risk) => !baseRisks.has(riskKey(risk)))
    .flatMap((risk) => checkoutRiskFindings(head, risk));
}

function diffOidcCloudAuth(
  base: GitHubActionsWorkflow | undefined,
  head: GitHubActionsWorkflow,
): Finding[] {
  const baseActions = new Set(actionUsages(base).map(actionUsageKey));
  const findings: Finding[] = [];

  for (const usage of actionUsages(head)) {
    if (
      !isCloudAuthAction(usage.uses) ||
      baseActions.has(actionUsageKey(usage))
    ) {
      continue;
    }

    const headHasOidc =
      effectivePermission(head, usage.job, "id-token") === "write";
    if (!headHasOidc) {
      continue;
    }

    const baseHadOidc =
      base !== undefined &&
      effectivePermission(base, usage.job, "id-token") === "write";

    findings.push({
      id: "oidc-cloud-auth-added",
      title: "Cloud authentication action added with OIDC enabled",
      severity: baseHadOidc ? "high" : "critical",
      category: "oidc",
      file: head.path,
      job: usage.job,
      evidence: [
        `Added cloud authentication action \`${usage.uses}\`.`,
        "Job or workflow grants `id-token: write`.",
      ],
      recommendation:
        "Verify cloud trust policies are constrained to the intended repository, branch, environment, and workflow.",
    });
  }

  return findings;
}

function diffRunnerAndExecution(
  base: GitHubActionsWorkflow | undefined,
  head: GitHubActionsWorkflow,
): Finding[] {
  const findings: Finding[] = [];

  for (const [jobId, headJob] of Object.entries(head.jobs)) {
    const baseJob = base?.jobs[jobId];

    if (
      headJob.runsOn.includes("self-hosted") &&
      !baseJob?.runsOn.includes("self-hosted")
    ) {
      findings.push({
        id: "self-hosted-runner-added",
        title: "Self-hosted runner added",
        severity: "high",
        category: "runner",
        file: head.path,
        job: jobId,
        before: baseJob?.runsOn,
        after: headJob.runsOn,
        evidence: [
          `Job \`${jobId}\` now runs on ${formatList(headJob.runsOn)}.`,
        ],
        recommendation:
          "Confirm self-hosted runner labels are protected and appropriate for this workflow.",
      });
    } else if (
      baseJob &&
      headJob.runsOn.length > 0 &&
      !sameStringSet(baseJob.runsOn, headJob.runsOn)
    ) {
      findings.push({
        id: "runner-label-changed",
        title: "Runner label changed",
        severity: "medium",
        category: "runner",
        file: head.path,
        job: jobId,
        before: baseJob.runsOn,
        after: headJob.runsOn,
        evidence: [
          `Job \`${jobId}\` runner changed from ${formatList(baseJob.runsOn)} to ${formatList(headJob.runsOn)}.`,
        ],
        recommendation:
          "Confirm the new runner labels use the intended trust boundary and runtime image.",
      });
    }

    if (
      headJob.containerImage &&
      headJob.containerImage !== baseJob?.containerImage
    ) {
      findings.push({
        id: "container-image-changed",
        title: "Container image changed",
        severity: "medium",
        category: "runner",
        file: head.path,
        job: jobId,
        before: baseJob?.containerImage,
        after: headJob.containerImage,
        evidence: [
          `Job \`${jobId}\` container image is now \`${headJob.containerImage}\`.`,
        ],
        recommendation: imageUsesLatest(headJob.containerImage)
          ? "Avoid mutable :latest container tags in CI workflows."
          : "Confirm the container image source and tag are trusted.",
      });
    }

    const baseServices = new Map(
      (baseJob?.services ?? []).map((service) => [service.name, service]),
    );
    for (const service of headJob.services) {
      const baseService = baseServices.get(service.name);
      if (
        baseService?.image === service.image &&
        baseService?.options === service.options
      ) {
        continue;
      }

      const privileged = isPrivilegedService(service.image, service.options);
      findings.push({
        id: privileged ? "privileged-service-added" : "service-added",
        title: privileged
          ? "Privileged service added"
          : "Workflow service added",
        severity: privileged ? "high" : "medium",
        category: "runner",
        file: head.path,
        job: jobId,
        before: baseService?.raw,
        after: service.raw,
        evidence: [
          `Job \`${jobId}\` service \`${service.name}\` uses \`${service.image ?? "unknown image"}\`.`,
        ],
        recommendation: privileged
          ? "Review privileged services carefully; docker-in-docker can expand the workflow execution boundary."
          : "Confirm the service image and runtime options are trusted.",
      });
    }

    for (const headStep of headJob.steps) {
      const baseStep = baseJob?.steps[headStep.index];
      if (
        headStep.shell &&
        baseStep?.shell !== undefined &&
        headStep.shell !== baseStep.shell
      ) {
        findings.push({
          id: "shell-changed",
          title: "Step shell changed",
          severity: "low",
          category: "runner",
          file: head.path,
          job: jobId,
          before: baseStep.shell,
          after: headStep.shell,
          evidence: [
            `Job \`${jobId}\` step ${headStep.index + 1} shell changed from \`${baseStep.shell}\` to \`${headStep.shell}\`.`,
          ],
          recommendation:
            "Confirm the new shell handles quoting, errors, and platform behavior as expected.",
        });
      }
    }
  }

  return findings;
}

function diffDeploymentEnvironments(
  base: GitHubActionsWorkflow | undefined,
  head: GitHubActionsWorkflow,
): Finding[] {
  const findings: Finding[] = [];

  for (const [jobId, headJob] of Object.entries(head.jobs)) {
    const baseEnvironment = base?.jobs[jobId]?.environment;
    const headEnvironment = headJob.environment;

    if (!headEnvironment || headEnvironment === baseEnvironment) {
      continue;
    }

    const production = isProductionEnvironment(headEnvironment);
    const changedToProduction = production && baseEnvironment !== undefined;

    findings.push({
      id: production
        ? "deployment-production-added"
        : baseEnvironment
          ? "deployment-environment-changed"
          : "deployment-environment-added",
      title: production
        ? "Production deployment environment added"
        : baseEnvironment
          ? "Deployment environment changed"
          : "Deployment environment added",
      severity: changedToProduction
        ? "critical"
        : production
          ? "high"
          : "medium",
      category: "deployment",
      file: head.path,
      job: jobId,
      before: baseEnvironment,
      after: headEnvironment,
      evidence: [
        `Job \`${jobId}\` environment changed from \`${baseEnvironment ?? "none"}\` to \`${headEnvironment}\`.`,
      ],
      recommendation: production
        ? "Confirm production environment protections and required reviewers are configured."
        : "Confirm this deployment environment change is intentional.",
    });
  }

  return findings;
}

function diffActionUses(
  base: GitHubActionsWorkflow | undefined,
  head: GitHubActionsWorkflow,
): Finding[] {
  const findings: Finding[] = [];

  for (const usage of actionUsages(head)) {
    const baseUsage = base?.jobs[usage.job]?.steps[usage.step.index]?.uses;
    if (usage.uses === baseUsage) {
      continue;
    }

    const parsedHead = parseUses(usage.uses);
    const parsedBase = baseUsage ? parseUses(baseUsage) : undefined;
    const floating = isFloatingRef(parsedHead.ref);

    if (!baseUsage) {
      if (parsedHead.kind === "docker") {
        findings.push(
          actionFinding(head.path, usage, {
            id: "action-docker-url-added",
            title: "Docker action added",
            severity: "high",
            evidence: `Added Docker action \`${usage.uses}\`.`,
            recommendation:
              "Review Docker actions carefully and prefer pinned immutable references.",
          }),
        );
      } else if (floating) {
        findings.push(floatingActionFinding(head.path, usage));
      } else {
        findings.push(
          actionFinding(head.path, usage, {
            id: "action-added",
            title: "Workflow action added",
            severity: isFirstPartyAction(parsedHead.name) ? "low" : "medium",
            evidence: `Added action \`${usage.uses}\`.`,
            recommendation:
              "Confirm the action source and version are trusted before merge.",
          }),
        );
      }
      continue;
    }

    if (
      parsedBase &&
      parsedBase.name === parsedHead.name &&
      parsedBase.ref !== parsedHead.ref
    ) {
      if (isPinnedSha(parsedBase.ref) && !isPinnedSha(parsedHead.ref)) {
        findings.push(
          actionFinding(head.path, usage, {
            id: "action-unpinned",
            title: "Action changed from pinned SHA to mutable ref",
            severity: "high",
            evidence: `Action \`${parsedHead.name}\` changed from \`${parsedBase.ref}\` to \`${parsedHead.ref ?? "no ref"}\`.`,
            recommendation:
              "Pin third-party actions to a reviewed commit SHA where practical.",
          }),
        );
      } else if (floating) {
        findings.push(floatingActionFinding(head.path, usage));
      } else {
        findings.push(
          actionFinding(head.path, usage, {
            id: "action-version-changed",
            title: "Action version changed",
            severity: "medium",
            evidence: `Action changed from \`${baseUsage}\` to \`${usage.uses}\`.`,
            recommendation:
              "Review the action changelog and trust boundary for the new version.",
          }),
        );
      }
    } else {
      findings.push(
        actionFinding(head.path, usage, {
          id: "action-added",
          title: "Workflow action changed",
          severity: isFirstPartyAction(parsedHead.name) ? "low" : "medium",
          evidence: `Action changed from \`${baseUsage}\` to \`${usage.uses}\`.`,
          recommendation:
            "Confirm the replacement action source and version are trusted.",
        }),
      );
    }
  }

  return findings;
}

function diffJobGraph(
  base: GitHubActionsWorkflow | undefined,
  head: GitHubActionsWorkflow,
): Finding[] {
  const findings: Finding[] = [];
  const baseJobs = base?.jobs ?? {};

  for (const [jobId, headJob] of Object.entries(head.jobs)) {
    const baseJob = baseJobs[jobId];

    if (!baseJob) {
      findings.push({
        id: "job-added",
        title: "Workflow job added",
        severity: isDeployJob(jobId, headJob) ? "medium" : "low",
        category: "workflow-graph",
        file: head.path,
        job: jobId,
        evidence: [`Job \`${jobId}\` was added.`],
        recommendation:
          "Confirm the new job has the intended dependencies, permissions, and execution environment.",
      });
      continue;
    }

    const removedNeeds = baseJob.needs.filter(
      (need) => !headJob.needs.includes(need),
    );
    const addedNeeds = headJob.needs.filter(
      (need) => !baseJob.needs.includes(need),
    );

    if (removedNeeds.length > 0) {
      findings.push({
        id: "job-dependency-removed",
        title: "Job dependency removed",
        severity: "medium",
        category: "workflow-graph",
        file: head.path,
        job: jobId,
        before: baseJob.needs,
        after: headJob.needs,
        evidence: [
          `Job \`${jobId}\` no longer needs ${formatList(removedNeeds)}.`,
        ],
        recommendation:
          "Confirm removing this dependency does not bypass validation or build gates.",
      });

      if (isDeployJob(jobId, headJob) && removedNeeds.some(isGateJobName)) {
        findings.push({
          id: "possible-deploy-gate-removed",
          title: "Possible deploy gate removed",
          severity: "high",
          category: "workflow-graph",
          file: head.path,
          job: jobId,
          before: baseJob.needs,
          after: headJob.needs,
          evidence: [
            `Deploy-like job \`${jobId}\` no longer depends on ${formatList(removedNeeds.filter(isGateJobName))}.`,
          ],
          recommendation:
            "Keep deploy and release jobs dependent on test, lint, or build jobs unless the gate moved elsewhere.",
        });
      }
    }

    if (addedNeeds.length > 0) {
      findings.push({
        id: "job-dependency-added",
        title: "Job dependency added",
        severity: "info",
        category: "workflow-graph",
        file: head.path,
        job: jobId,
        before: baseJob.needs,
        after: headJob.needs,
        evidence: [`Job \`${jobId}\` now needs ${formatList(addedNeeds)}.`],
        recommendation:
          "Confirm the new dependency order matches the intended workflow graph.",
      });
    }
  }

  for (const jobId of Object.keys(baseJobs)) {
    if (!(jobId in head.jobs)) {
      findings.push({
        id: "job-removed",
        title: "Workflow job removed",
        severity: "medium",
        category: "workflow-graph",
        file: head.path,
        job: jobId,
        evidence: [`Job \`${jobId}\` was removed.`],
        recommendation:
          "Confirm the removed job is no longer required by branch protection or release gates.",
      });
    }
  }

  return findings;
}

function checkoutRiskFindings(
  workflow: GitHubActionsWorkflow,
  risk: CheckoutRisk,
): Finding[] {
  const findings: Finding[] = [];

  if (!("pull_request_target" in workflow.triggers)) {
    return findings;
  }

  if (risk.hasWriteToken) {
    findings.push({
      id: "untrusted-checkout-with-write-token",
      title: "Pull request head checkout has write token access",
      severity: "critical",
      category: "checkout",
      file: workflow.path,
      job: risk.job.id,
      evidence: [
        "Workflow is triggered by `pull_request_target`.",
        checkoutEvidence(risk.step),
        "Job or workflow grants write access to `GITHUB_TOKEN`.",
      ],
      recommendation:
        "Avoid checking out pull request head code in privileged workflows. Use the merge commit or run untrusted code in a separate pull_request workflow with read-only permissions.",
    });
  }

  if (risk.hasSecrets) {
    findings.push({
      id: "untrusted-checkout-with-secrets",
      title: "Pull request head checkout can access secrets",
      severity: "critical",
      category: "checkout",
      file: workflow.path,
      job: risk.job.id,
      evidence: [
        "Workflow is triggered by `pull_request_target`.",
        checkoutEvidence(risk.step),
        "Job uses `secrets.*` values.",
      ],
      recommendation:
        "Keep secrets out of jobs that checkout untrusted pull request head code.",
    });
  }

  if (!risk.hasWriteToken && !risk.hasSecrets) {
    findings.push({
      id: "untrusted-checkout-with-pull-request-target",
      title: "Pull request head checkout added under pull_request_target",
      severity: "high",
      category: "checkout",
      file: workflow.path,
      job: risk.job.id,
      evidence: [
        "Workflow is triggered by `pull_request_target`.",
        checkoutEvidence(risk.step),
      ],
      recommendation:
        "Avoid checking out untrusted pull request head code in a privileged workflow.",
    });
  }

  return findings;
}

function collectUntrustedCheckoutRisks(
  workflow: GitHubActionsWorkflow | undefined,
): CheckoutRisk[] {
  if (!workflow) {
    return [];
  }

  const risks: CheckoutRisk[] = [];
  const secretUsages = collectSecretUsages(workflow);

  for (const job of Object.values(workflow.jobs)) {
    const jobHasWrite = effectiveHasWritePermission(workflow, job);
    const jobHasIdToken =
      effectivePermission(workflow, job.id, "id-token") === "write";
    const jobHasSecrets = secretUsages.some(
      (usage) => usage.job === undefined || usage.job === job.id,
    );

    for (const step of job.steps) {
      if (!isCheckoutStep(step) || !checkoutUsesPullRequestHead(step)) {
        continue;
      }

      risks.push({
        job,
        step,
        hasWriteToken: jobHasWrite || jobHasIdToken,
        hasSecrets: jobHasSecrets,
      });
    }
  }

  return risks;
}

interface CheckoutRisk {
  job: NormalizedJob;
  step: NormalizedStep;
  hasWriteToken: boolean;
  hasSecrets: boolean;
}

interface SecretUsage {
  key: string;
  job?: string;
  location: string;
  value: string;
  inRun: boolean;
}

function collectSecretUsages(
  workflow: GitHubActionsWorkflow | undefined,
): SecretUsage[] {
  if (!workflow) {
    return [];
  }

  const usages: SecretUsage[] = [];

  for (const [name, value] of Object.entries(workflow.parsed.env ?? {})) {
    collectSecretStrings(
      value,
      `workflow env ${name}`,
      undefined,
      false,
      usages,
    );
  }

  for (const job of Object.values(workflow.jobs)) {
    for (const [name, value] of Object.entries(job.env)) {
      collectSecretStrings(value, `job env ${name}`, job.id, false, usages);
    }

    for (const step of job.steps) {
      const stepLabel = step.name ?? `step ${step.index + 1}`;

      if (step.run) {
        collectSecretStrings(
          step.run,
          `${stepLabel} run`,
          job.id,
          true,
          usages,
        );
      }

      for (const [name, value] of Object.entries(step.env)) {
        collectSecretStrings(
          value,
          `${stepLabel} env ${name}`,
          job.id,
          false,
          usages,
        );
      }

      for (const [name, value] of Object.entries(step.with)) {
        collectSecretStrings(
          value,
          `${stepLabel} input ${name}`,
          job.id,
          false,
          usages,
        );
      }
    }
  }

  return usages;
}

function collectSecretStrings(
  value: unknown,
  location: string,
  job: string | undefined,
  inRun: boolean,
  usages: SecretUsage[],
): void {
  if (typeof value === "string") {
    if (secretPattern.test(value)) {
      usages.push({
        key: `${job ?? ""}|${location}|${value}`,
        job,
        location,
        value,
        inRun,
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectSecretStrings(item, `${location}[${index}]`, job, inRun, usages),
    );
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as JsonObject)) {
      collectSecretStrings(child, `${location}.${key}`, job, inRun, usages);
    }
  }
}

function permissionWriteFinding(
  params: {
    file: string;
    job?: string;
    base?: NormalizedPermissions;
    head: NormalizedPermissions;
  },
  scope: string,
  before: string,
): Finding {
  if (scope === "id-token") {
    return {
      id: "permission-id-token-write-added",
      title: "OIDC token write permission added",
      severity: "critical",
      category: "oidc",
      file: params.file,
      job: params.job,
      before,
      after: "write",
      evidence: [
        `${permissionLocation(params.job)} now grants \`id-token: write\`.`,
      ],
      recommendation:
        "Confirm this workflow needs OIDC cloud credentials and restrict cloud trust policies to the narrowest repository, branch, and environment claims.",
    };
  }

  const severity = sensitiveWriteScopes.get(scope) ?? "medium";
  return {
    id: sensitiveWriteScopes.has(scope)
      ? "permission-sensitive-write-added"
      : "permission-elevated",
    title: `GITHUB_TOKEN ${scope} write permission added`,
    severity,
    category: "permission",
    file: params.file,
    job: params.job,
    before,
    after: "write",
    evidence: [
      `${permissionLocation(params.job)} changed \`${scope}\` permission from \`${before}\` to \`write\`.`,
    ],
    recommendation:
      "Keep GITHUB_TOKEN permissions read-only unless this workflow specifically needs write access.",
  };
}

function triggerFindingDetails(event: string): {
  id: string;
  title: string;
  severity: Severity;
  recommendation: string;
} {
  if (event === "pull_request_target") {
    return {
      id: "trigger-pull-request-target-added",
      title: "pull_request_target trigger added",
      severity: "critical",
      recommendation:
        "Review this workflow carefully. Do not checkout or execute untrusted pull request code in pull_request_target workflows.",
    };
  }

  if (event === "workflow_run") {
    return {
      id: "trigger-workflow-run-added",
      title: "workflow_run trigger added",
      severity: "high",
      recommendation:
        "Confirm downstream workflow execution cannot be influenced by untrusted upstream artifacts or code.",
    };
  }

  if (event === "schedule") {
    return {
      id: "trigger-schedule-added",
      title: "Scheduled trigger added",
      severity: "medium",
      recommendation:
        "Confirm scheduled automation is intentional and has appropriate permissions.",
    };
  }

  if (event === "workflow_dispatch") {
    return {
      id: "trigger-workflow-dispatch-added",
      title: "Manual workflow trigger added",
      severity: "low",
      recommendation:
        "Confirm manual runs are acceptable for this workflow and its permissions.",
    };
  }

  return {
    id: "trigger-event-added",
    title: "Workflow trigger added",
    severity: "low",
    recommendation:
      "Confirm the new trigger matches the intended workflow execution paths.",
  };
}

function workflowAddedFinding(workflow: GitHubActionsWorkflow): Finding {
  return {
    id: "workflow-added",
    title: "Workflow file added",
    severity: "medium",
    category: "config",
    file: workflow.path,
    evidence: [`New workflow file detected: ${workflow.path}`],
    recommendation:
      "Review new workflow triggers and permissions before merge.",
  };
}

function workflowRemovedFinding(workflow: GitHubActionsWorkflow): Finding {
  return {
    id: "workflow-removed",
    title: "Workflow file removed",
    severity: "medium",
    category: "config",
    file: workflow.path,
    evidence: [`Workflow file removed: ${workflow.path}`],
    recommendation:
      "Ensure the removal is intentional and does not break required checks.",
  };
}

function byPath(
  workflows: GitHubActionsWorkflow[],
): Map<string, GitHubActionsWorkflow> {
  return new Map(workflows.map((workflow) => [workflow.path, workflow]));
}

function permissionLocation(job?: string): string {
  return job ? `Job \`${job}\`` : "Workflow";
}

function isCheckoutStep(step: NormalizedStep): boolean {
  return step.uses?.toLowerCase().startsWith("actions/checkout@") ?? false;
}

function checkoutUsesPullRequestHead(step: NormalizedStep): boolean {
  const values = [
    typeof step.with.ref === "string" ? step.with.ref : "",
    typeof step.with.repository === "string" ? step.with.repository : "",
  ];

  return values.some((value) =>
    prHeadPatterns.some((pattern) => value.includes(pattern)),
  );
}

function checkoutEvidence(step: NormalizedStep): string {
  const details = Object.entries(step.with)
    .filter(([key]) => key === "ref" || key === "repository")
    .map(([key, value]) => `${key}: \`${String(value)}\``)
    .join(", ");

  return details
    ? `Checkout uses pull request head code (${details}).`
    : "Checkout uses pull request head code.";
}

function riskKey(risk: CheckoutRisk): string {
  return `${risk.job.id}|${risk.step.index}|${risk.hasWriteToken}|${risk.hasSecrets}`;
}

function groupBy<T>(
  values: T[],
  keyFn: (value: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const value of values) {
    const key = keyFn(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }

  return groups;
}

interface ActionUsage {
  job: string;
  step: NormalizedStep;
  uses: string;
}

interface ParsedUses {
  kind: "action" | "docker" | "local";
  name: string;
  ref?: string;
}

function actionUsages(
  workflow: GitHubActionsWorkflow | undefined,
): ActionUsage[] {
  if (!workflow) {
    return [];
  }

  return Object.values(workflow.jobs).flatMap((job) =>
    job.steps.flatMap((step) =>
      step.uses ? [{ job: job.id, step, uses: step.uses }] : [],
    ),
  );
}

function actionUsageKey(usage: ActionUsage): string {
  return `${usage.job}|${usage.step.index}|${usage.uses}`;
}

function parseUses(uses: string): ParsedUses {
  if (uses.startsWith("docker://")) {
    return { kind: "docker", name: uses };
  }

  if (uses.startsWith("./") || uses.startsWith("../")) {
    return { kind: "local", name: uses };
  }

  const atIndex = uses.lastIndexOf("@");
  if (atIndex === -1) {
    return { kind: "action", name: uses };
  }

  return {
    kind: "action",
    name: uses.slice(0, atIndex),
    ref: uses.slice(atIndex + 1),
  };
}

function isPinnedSha(ref: string | undefined): boolean {
  return /^[a-f0-9]{40}$/i.test(ref ?? "");
}

function isFloatingRef(ref: string | undefined): boolean {
  return (
    ref === undefined ||
    ref === "" ||
    ref === "main" ||
    ref === "master" ||
    ref === "latest"
  );
}

function isFirstPartyAction(name: string): boolean {
  return name.startsWith("actions/") || name.startsWith("github/");
}

function isCloudAuthAction(uses: string): boolean {
  const normalized = parseUses(uses).name.toLowerCase();
  return (
    normalized === "aws-actions/configure-aws-credentials" ||
    normalized === "azure/login" ||
    normalized === "google-github-actions/auth"
  );
}

function floatingActionFinding(file: string, usage: ActionUsage): Finding {
  return actionFinding(file, usage, {
    id: "action-floating-ref-added",
    title: "Action uses a floating ref",
    severity: "high",
    evidence: `Action \`${usage.uses}\` uses a mutable ref.`,
    recommendation:
      "Use an immutable version or pinned commit SHA for workflow actions.",
  });
}

function actionFinding(
  file: string,
  usage: ActionUsage,
  params: {
    id: string;
    title: string;
    severity: Severity;
    evidence: string;
    recommendation: string;
  },
): Finding {
  return {
    id: params.id,
    title: params.title,
    severity: params.severity,
    category: "supply-chain",
    file,
    job: usage.job,
    evidence: [params.evidence],
    recommendation: params.recommendation,
  };
}

function effectivePermission(
  workflow: GitHubActionsWorkflow,
  jobId: string,
  scope: string,
): "none" | "read" | "write" {
  const job = workflow.jobs[jobId];
  if (job && job.permissions.mode !== "unset") {
    return permissionAccess(job.permissions, scope);
  }

  return permissionAccess(workflow.permissions, scope);
}

function effectiveHasWritePermission(
  workflow: GitHubActionsWorkflow,
  job: NormalizedJob,
): boolean {
  if (job.permissions.mode !== "unset") {
    return hasWritePermission(job.permissions);
  }

  return hasWritePermission(workflow.permissions);
}

function filterWidened(base: string[], head: string[]): boolean {
  if (base.length === 0) {
    return false;
  }

  if (head.length === 0) {
    return true;
  }

  return head.some((value) => value === "*" || value === "**");
}

function pathFilterRemovedFinding(
  file: string,
  event: string,
  filterName: "paths" | "paths-ignore",
): Finding {
  return {
    id: "trigger-path-filter-removed",
    title: `${event} ${filterName} filter removed`,
    severity: "medium",
    category: "trigger",
    file,
    before: filterName,
    after: undefined,
    evidence: [`\`${event}\` removed its \`${filterName}\` filter.`],
    recommendation:
      "Confirm the workflow should run for the broader set of changed files.",
  };
}

function sameStringSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

function formatList(values: string[]): string {
  if (values.length === 0) {
    return "`<all>`";
  }

  return values.map((value) => `\`${value}\``).join(", ");
}

function imageUsesLatest(image: string): boolean {
  return image.endsWith(":latest") || !image.includes(":");
}

function isPrivilegedService(
  image: string | undefined,
  options: string | undefined,
): boolean {
  return (
    image?.toLowerCase() === "docker:dind" ||
    options?.toLowerCase().includes("privileged") === true
  );
}

function isProductionEnvironment(environment: string): boolean {
  return /^prod(uction)?$/i.test(environment);
}

function isDeployJob(jobId: string, job: NormalizedJob): boolean {
  const haystack = `${jobId} ${job.name ?? ""}`.toLowerCase();
  return (
    haystack.includes("deploy") ||
    haystack.includes("release") ||
    haystack.includes("publish")
  );
}

function isGateJobName(jobId: string): boolean {
  const normalized = jobId.toLowerCase();
  return (
    normalized.includes("test") ||
    normalized.includes("lint") ||
    normalized.includes("build")
  );
}

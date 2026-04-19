// src/core/severity.ts
var severityRank = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};
function compareSeverity(a, b) {
  return severityRank[b] - severityRank[a];
}
function maxSeverity(findings) {
  if (findings.length === 0) {
    return "none";
  }
  return findings.map((finding) => finding.severity).sort((a, b) => compareSeverity(a, b))[0];
}
function getSummary(findings) {
  const summary = {
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0
  };
  for (const finding of findings) {
    summary[finding.severity] += 1;
  }
  return summary;
}
function meetsThreshold(findings, threshold) {
  if (threshold === "none") {
    return false;
  }
  return findings.some(
    (finding) => severityRank[finding.severity] >= severityRank[threshold]
  );
}

// src/core/report.ts
function buildReport(params) {
  const findings = [...params.findings].sort((a, b) => {
    if (a.severity !== b.severity) {
      const order = ["critical", "high", "medium", "low", "info"];
      return order.indexOf(a.severity) - order.indexOf(b.severity);
    }
    if (a.category !== b.category) {
      return a.category.localeCompare(b.category);
    }
    return a.file.localeCompare(b.file);
  });
  return {
    provider: params.provider,
    baseRef: params.baseRef,
    headRef: params.headRef,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    changedFiles: [...params.changedFiles].sort(),
    maxSeverity: maxSeverity(findings),
    summary: getSummary(findings),
    findings
  };
}

// src/core/engine.ts
async function compareSources({
  provider,
  baseSource,
  headSource,
  globs = provider.workflowGlobs,
  baseRef,
  headRef
}) {
  const [baseFiles, headFiles] = await Promise.all([
    baseSource.listFiles(globs),
    headSource.listFiles(globs)
  ]);
  const [baseSnapshot, headSnapshot] = await Promise.all([
    provider.parse(baseFiles),
    provider.parse(headFiles)
  ]);
  const findings = await provider.diff(baseSnapshot, headSnapshot);
  return buildReport({
    provider: provider.id,
    baseRef,
    headRef,
    changedFiles: changedFilePaths(baseFiles, headFiles),
    findings
  });
}
function changedFilePaths(baseFiles, headFiles) {
  const paths = /* @__PURE__ */ new Set();
  const baseByPath = toPathMap(baseFiles);
  const headByPath = toPathMap(headFiles);
  for (const path of /* @__PURE__ */ new Set([...baseByPath.keys(), ...headByPath.keys()])) {
    const base = baseByPath.get(path);
    const head = headByPath.get(path);
    if (!base || !head) {
      paths.add(path);
      continue;
    }
    if (base.content !== head.content || base.sha !== head.sha) {
      paths.add(path);
    }
  }
  return [...paths].sort();
}
function toPathMap(files) {
  return new Map(files.map((file) => [file.path, file]));
}

// src/providers/github-actions/normalize.ts
function normalizeWorkflow(path, raw, parsed) {
  const root = asRecord(parsed) ?? {};
  return {
    path,
    raw,
    parsed: root,
    name: stringValue(root.name),
    triggers: normalizeTriggers(root.on),
    permissions: normalizePermissions(root.permissions),
    jobs: normalizeJobs(root.jobs)
  };
}
function normalizeTriggers(value) {
  const triggers = {};
  if (typeof value === "string") {
    addTrigger(triggers, value, void 0);
    return triggers;
  }
  if (Array.isArray(value)) {
    for (const event of value) {
      if (typeof event === "string") {
        addTrigger(triggers, event, void 0);
      }
    }
    return triggers;
  }
  const triggerMap = asRecord(value);
  if (!triggerMap) {
    return triggers;
  }
  for (const [event, config] of Object.entries(triggerMap)) {
    addTrigger(triggers, event, config);
  }
  return triggers;
}
function normalizePermissions(value) {
  if (value === void 0 || value === null) {
    return { mode: "unset", scopes: {}, raw: value };
  }
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "read-all" || normalized === "write-all") {
      return { mode: normalized, scopes: {}, raw: value };
    }
    return { mode: "scoped", scopes: {}, raw: value };
  }
  const map = asRecord(value);
  if (!map) {
    return { mode: "unset", scopes: {}, raw: value };
  }
  const entries = Object.entries(map);
  if (entries.length === 0) {
    return { mode: "none", scopes: {}, raw: value };
  }
  const scopes = {};
  for (const [scope, access] of entries) {
    const normalized = normalizePermissionAccess(access);
    if (normalized) {
      scopes[scope] = normalized;
    }
  }
  return { mode: "scoped", scopes, raw: value };
}
function permissionAccess(permissions, scope) {
  if (permissions.mode === "write-all") {
    return "write";
  }
  if (permissions.mode === "read-all") {
    return "read";
  }
  if (permissions.mode === "none") {
    return "none";
  }
  return permissions.scopes[scope] ?? "none";
}
function hasWritePermission(permissions) {
  if (permissions.mode === "write-all") {
    return true;
  }
  return Object.values(permissions.scopes).some((access) => access === "write");
}
function explicitWriteScopes(permissions) {
  if (permissions.mode === "write-all") {
    return ["*"];
  }
  return Object.entries(permissions.scopes).filter(([, access]) => access === "write").map(([scope]) => scope).sort();
}
function normalizeJobs(value) {
  const jobMap = asRecord(value);
  if (!jobMap) {
    return {};
  }
  const jobs = {};
  for (const [id, rawJob] of Object.entries(jobMap)) {
    const job = asRecord(rawJob);
    if (!job) {
      continue;
    }
    jobs[id] = {
      id,
      name: stringValue(job.name),
      raw: job,
      runsOn: stringList(job["runs-on"]),
      permissions: normalizePermissions(job.permissions),
      needs: stringList(job.needs),
      environment: normalizeEnvironment(job.environment),
      containerImage: normalizeContainerImage(job.container),
      services: normalizeServices(job.services),
      steps: normalizeSteps(job.steps),
      env: asRecord(job.env) ?? {}
    };
  }
  return jobs;
}
function stringList(value) {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string");
  }
  return [];
}
function asRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return null;
}
function stringValue(value) {
  return typeof value === "string" ? value : void 0;
}
function addTrigger(triggers, event, config) {
  const triggerConfig = asRecord(config) ?? {};
  triggers[event] = {
    name: event,
    raw: config,
    branches: stringList(triggerConfig.branches),
    branchesIgnore: stringList(triggerConfig["branches-ignore"]),
    paths: stringList(triggerConfig.paths),
    pathsIgnore: stringList(triggerConfig["paths-ignore"]),
    tags: stringList(triggerConfig.tags)
  };
}
function normalizePermissionAccess(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const normalized = value.toLowerCase();
  if (normalized === "read" || normalized === "write" || normalized === "none") {
    return normalized;
  }
  return void 0;
}
function normalizeEnvironment(value) {
  if (typeof value === "string") {
    return value;
  }
  const map = asRecord(value);
  return stringValue(map?.name);
}
function normalizeContainerImage(value) {
  if (typeof value === "string") {
    return value;
  }
  const map = asRecord(value);
  return stringValue(map?.image);
}
function normalizeServices(value) {
  const services = asRecord(value);
  if (!services) {
    return [];
  }
  return Object.entries(services).map(([name, rawService]) => {
    if (typeof rawService === "string") {
      return { name, image: rawService, raw: rawService };
    }
    const service = asRecord(rawService);
    return {
      name,
      image: stringValue(service?.image),
      options: stringValue(service?.options),
      raw: rawService
    };
  });
}
function normalizeSteps(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((rawStep, index) => {
    const step = asRecord(rawStep);
    if (!step) {
      return [];
    }
    return {
      index,
      name: stringValue(step.name),
      uses: stringValue(step.uses),
      run: stringValue(step.run),
      shell: stringValue(step.shell),
      with: asRecord(step.with) ?? {},
      env: asRecord(step.env) ?? {},
      raw: step
    };
  });
}

// src/providers/github-actions/adapter.ts
import { parseDocument } from "yaml";

// src/providers/github-actions/diff.ts
var sensitiveWriteScopes = /* @__PURE__ */ new Map([
  ["contents", "high"],
  ["pull-requests", "high"],
  ["actions", "high"],
  ["checks", "high"],
  ["security-events", "high"],
  ["packages", "medium"]
]);
var secretPattern = /\bsecrets(?:\.[A-Za-z_][\w-]*|\s*\[)/;
var prHeadPatterns = [
  "github.event.pull_request.head.sha",
  "github.head_ref",
  "github.event.pull_request.head.repo.full_name"
];
function diffWorkflows(baseWorkflows, headWorkflows) {
  const findings = [];
  const baseByPath = byPath(baseWorkflows);
  const headByPath = byPath(headWorkflows);
  const paths = [
    .../* @__PURE__ */ new Set([...baseByPath.keys(), ...headByPath.keys()])
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
      findings.push(...diffWorkflow(void 0, head));
      continue;
    }
    if (base && head && base.raw !== head.raw) {
      findings.push(...diffWorkflow(base, head));
    }
  }
  return findings;
}
function diffWorkflow(base, head) {
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
    ...diffJobGraph(base, head)
  ];
}
function diffTriggerAdditions(base, head) {
  const findings = [];
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
      before: void 0,
      after: event,
      evidence: [`New trigger: \`${event}\``],
      recommendation: special.recommendation
    });
  }
  return findings;
}
function diffTriggerChanges(base, head) {
  const findings = [];
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
        after: void 0,
        evidence: [`Removed trigger: \`${event}\``],
        recommendation: "Confirm this workflow should no longer run for the removed event."
      });
    }
  }
  for (const [event, headTrigger] of Object.entries(head.triggers)) {
    const baseTrigger = baseTriggers[event];
    if (!baseTrigger) {
      continue;
    }
    const branchSeverity = event === "push" ? "high" : "medium";
    if ((event === "push" || event === "pull_request") && filterWidened(baseTrigger.branches, headTrigger.branches)) {
      findings.push({
        id: "trigger-filter-widened",
        title: `${event} branch filter widened`,
        severity: branchSeverity,
        category: "trigger",
        file: head.path,
        before: baseTrigger.branches,
        after: headTrigger.branches,
        evidence: [
          `\`${event}\` branch filter changed from ${formatList(baseTrigger.branches)} to ${formatList(headTrigger.branches)}.`
        ],
        recommendation: "Confirm the workflow should run on the broader branch set."
      });
    }
    if (baseTrigger.paths.length > 0 && headTrigger.paths.length === 0) {
      findings.push(pathFilterRemovedFinding(head.path, event, "paths"));
    }
    if (baseTrigger.pathsIgnore.length > 0 && headTrigger.pathsIgnore.length === 0) {
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
          `\`${event}\` tag filter added: ${formatList(headTrigger.tags)}.`
        ],
        recommendation: "Confirm tag-triggered releases or deployments are intentional."
      });
    }
  }
  return findings;
}
function diffPermissionElevations(base, head) {
  const findings = [];
  findings.push(
    ...comparePermissions({
      file: head.path,
      base: base?.permissions,
      head: head.permissions
    })
  );
  for (const [jobId, headJob] of Object.entries(head.jobs)) {
    findings.push(
      ...comparePermissions({
        file: head.path,
        job: jobId,
        base: base?.jobs[jobId]?.permissions,
        head: headJob.permissions
      })
    );
  }
  return findings;
}
function comparePermissions(params) {
  const findings = [];
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
      recommendation: "Replace write-all with the minimum explicit permissions needed by this workflow."
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
function diffSecretUsage(base, head) {
  const baseUsageKeys = new Set(
    collectSecretUsages(base).map((usage) => usage.key)
  );
  const added = collectSecretUsages(head).filter(
    (usage) => !baseUsageKeys.has(usage.key)
  );
  if (added.length === 0) {
    return [];
  }
  const grouped = groupBy(added, (usage) => usage.job ?? "");
  const findings = [];
  const hasPullRequestTarget = "pull_request_target" in head.triggers;
  for (const [job, usages] of grouped) {
    const inRun = usages.filter((usage) => usage.inRun);
    const evidence = usages.slice(0, 6).map((usage) => `${usage.location}: \`${usage.value}\``);
    if (hasPullRequestTarget) {
      findings.push({
        id: "secret-with-pr-target",
        title: "Secret usage added to pull_request_target workflow",
        severity: "critical",
        category: "secret",
        file: head.path,
        job: job || void 0,
        evidence: [
          "Workflow is triggered by `pull_request_target`.",
          ...evidence
        ],
        recommendation: "Do not expose secrets to workflows that can be influenced by untrusted pull request code."
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
        job: job || void 0,
        evidence: inRun.slice(0, 6).map((usage) => `${usage.location}: \`${usage.value}\``),
        recommendation: "Prefer passing secrets through scoped action inputs or environment variables instead of interpolating them into shell commands."
      });
      continue;
    }
    findings.push({
      id: "secret-usage-added",
      title: "Secret usage added",
      severity: "medium",
      category: "secret",
      file: head.path,
      job: job || void 0,
      evidence,
      recommendation: "Confirm the secret is needed and is not reachable from untrusted workflow execution paths."
    });
  }
  return findings;
}
function diffUntrustedCheckouts(base, head) {
  const baseRisks = new Set(collectUntrustedCheckoutRisks(base).map(riskKey));
  return collectUntrustedCheckoutRisks(head).filter((risk) => !baseRisks.has(riskKey(risk))).flatMap((risk) => checkoutRiskFindings(head, risk));
}
function diffOidcCloudAuth(base, head) {
  const baseActions = new Set(actionUsages(base).map(actionUsageKey));
  const findings = [];
  for (const usage of actionUsages(head)) {
    if (!isCloudAuthAction(usage.uses) || baseActions.has(actionUsageKey(usage))) {
      continue;
    }
    const headHasOidc = effectivePermission(head, usage.job, "id-token") === "write";
    if (!headHasOidc) {
      continue;
    }
    const baseHadOidc = base !== void 0 && effectivePermission(base, usage.job, "id-token") === "write";
    findings.push({
      id: "oidc-cloud-auth-added",
      title: "Cloud authentication action added with OIDC enabled",
      severity: baseHadOidc ? "high" : "critical",
      category: "oidc",
      file: head.path,
      job: usage.job,
      evidence: [
        `Added cloud authentication action \`${usage.uses}\`.`,
        "Job or workflow grants `id-token: write`."
      ],
      recommendation: "Verify cloud trust policies are constrained to the intended repository, branch, environment, and workflow."
    });
  }
  return findings;
}
function diffRunnerAndExecution(base, head) {
  const findings = [];
  for (const [jobId, headJob] of Object.entries(head.jobs)) {
    const baseJob = base?.jobs[jobId];
    if (headJob.runsOn.includes("self-hosted") && !baseJob?.runsOn.includes("self-hosted")) {
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
          `Job \`${jobId}\` now runs on ${formatList(headJob.runsOn)}.`
        ],
        recommendation: "Confirm self-hosted runner labels are protected and appropriate for this workflow."
      });
    } else if (baseJob && headJob.runsOn.length > 0 && !sameStringSet(baseJob.runsOn, headJob.runsOn)) {
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
          `Job \`${jobId}\` runner changed from ${formatList(baseJob.runsOn)} to ${formatList(headJob.runsOn)}.`
        ],
        recommendation: "Confirm the new runner labels use the intended trust boundary and runtime image."
      });
    }
    if (headJob.containerImage && headJob.containerImage !== baseJob?.containerImage) {
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
          `Job \`${jobId}\` container image is now \`${headJob.containerImage}\`.`
        ],
        recommendation: imageUsesLatest(headJob.containerImage) ? "Avoid mutable :latest container tags in CI workflows." : "Confirm the container image source and tag are trusted."
      });
    }
    const baseServices = new Map(
      (baseJob?.services ?? []).map((service) => [service.name, service])
    );
    for (const service of headJob.services) {
      const baseService = baseServices.get(service.name);
      if (baseService?.image === service.image && baseService?.options === service.options) {
        continue;
      }
      const privileged = isPrivilegedService(service.image, service.options);
      findings.push({
        id: privileged ? "privileged-service-added" : "service-added",
        title: privileged ? "Privileged service added" : "Workflow service added",
        severity: privileged ? "high" : "medium",
        category: "runner",
        file: head.path,
        job: jobId,
        before: baseService?.raw,
        after: service.raw,
        evidence: [
          `Job \`${jobId}\` service \`${service.name}\` uses \`${service.image ?? "unknown image"}\`.`
        ],
        recommendation: privileged ? "Review privileged services carefully; docker-in-docker can expand the workflow execution boundary." : "Confirm the service image and runtime options are trusted."
      });
    }
    for (const headStep of headJob.steps) {
      const baseStep = baseJob?.steps[headStep.index];
      if (headStep.shell && baseStep?.shell !== void 0 && headStep.shell !== baseStep.shell) {
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
            `Job \`${jobId}\` step ${headStep.index + 1} shell changed from \`${baseStep.shell}\` to \`${headStep.shell}\`.`
          ],
          recommendation: "Confirm the new shell handles quoting, errors, and platform behavior as expected."
        });
      }
    }
  }
  return findings;
}
function diffDeploymentEnvironments(base, head) {
  const findings = [];
  for (const [jobId, headJob] of Object.entries(head.jobs)) {
    const baseEnvironment = base?.jobs[jobId]?.environment;
    const headEnvironment = headJob.environment;
    if (!headEnvironment || headEnvironment === baseEnvironment) {
      continue;
    }
    const production = isProductionEnvironment(headEnvironment);
    const changedToProduction = production && baseEnvironment !== void 0;
    findings.push({
      id: production ? "deployment-production-added" : baseEnvironment ? "deployment-environment-changed" : "deployment-environment-added",
      title: production ? "Production deployment environment added" : baseEnvironment ? "Deployment environment changed" : "Deployment environment added",
      severity: changedToProduction ? "critical" : production ? "high" : "medium",
      category: "deployment",
      file: head.path,
      job: jobId,
      before: baseEnvironment,
      after: headEnvironment,
      evidence: [
        `Job \`${jobId}\` environment changed from \`${baseEnvironment ?? "none"}\` to \`${headEnvironment}\`.`
      ],
      recommendation: production ? "Confirm production environment protections and required reviewers are configured." : "Confirm this deployment environment change is intentional."
    });
  }
  return findings;
}
function diffActionUses(base, head) {
  const findings = [];
  for (const usage of actionUsages(head)) {
    const baseUsage = base?.jobs[usage.job]?.steps[usage.step.index]?.uses;
    if (usage.uses === baseUsage) {
      continue;
    }
    const parsedHead = parseUses(usage.uses);
    const parsedBase = baseUsage ? parseUses(baseUsage) : void 0;
    const floating = isFloatingRef(parsedHead.ref);
    if (!baseUsage) {
      if (parsedHead.kind === "docker") {
        findings.push(
          actionFinding(head.path, usage, {
            id: "action-docker-url-added",
            title: "Docker action added",
            severity: "high",
            evidence: `Added Docker action \`${usage.uses}\`.`,
            recommendation: "Review Docker actions carefully and prefer pinned immutable references."
          })
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
            recommendation: "Confirm the action source and version are trusted before merge."
          })
        );
      }
      continue;
    }
    if (parsedBase && parsedBase.name === parsedHead.name && parsedBase.ref !== parsedHead.ref) {
      if (isPinnedSha(parsedBase.ref) && !isPinnedSha(parsedHead.ref)) {
        findings.push(
          actionFinding(head.path, usage, {
            id: "action-unpinned",
            title: "Action changed from pinned SHA to mutable ref",
            severity: "high",
            evidence: `Action \`${parsedHead.name}\` changed from \`${parsedBase.ref}\` to \`${parsedHead.ref ?? "no ref"}\`.`,
            recommendation: "Pin third-party actions to a reviewed commit SHA where practical."
          })
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
            recommendation: "Review the action changelog and trust boundary for the new version."
          })
        );
      }
    } else {
      findings.push(
        actionFinding(head.path, usage, {
          id: "action-added",
          title: "Workflow action changed",
          severity: isFirstPartyAction(parsedHead.name) ? "low" : "medium",
          evidence: `Action changed from \`${baseUsage}\` to \`${usage.uses}\`.`,
          recommendation: "Confirm the replacement action source and version are trusted."
        })
      );
    }
  }
  return findings;
}
function diffJobGraph(base, head) {
  const findings = [];
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
        recommendation: "Confirm the new job has the intended dependencies, permissions, and execution environment."
      });
      continue;
    }
    const removedNeeds = baseJob.needs.filter(
      (need) => !headJob.needs.includes(need)
    );
    const addedNeeds = headJob.needs.filter(
      (need) => !baseJob.needs.includes(need)
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
          `Job \`${jobId}\` no longer needs ${formatList(removedNeeds)}.`
        ],
        recommendation: "Confirm removing this dependency does not bypass validation or build gates."
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
            `Deploy-like job \`${jobId}\` no longer depends on ${formatList(removedNeeds.filter(isGateJobName))}.`
          ],
          recommendation: "Keep deploy and release jobs dependent on test, lint, or build jobs unless the gate moved elsewhere."
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
        recommendation: "Confirm the new dependency order matches the intended workflow graph."
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
        recommendation: "Confirm the removed job is no longer required by branch protection or release gates."
      });
    }
  }
  return findings;
}
function checkoutRiskFindings(workflow, risk) {
  const findings = [];
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
        "Job or workflow grants write access to `GITHUB_TOKEN`."
      ],
      recommendation: "Avoid checking out pull request head code in privileged workflows. Use the merge commit or run untrusted code in a separate pull_request workflow with read-only permissions."
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
        "Job uses `secrets.*` values."
      ],
      recommendation: "Keep secrets out of jobs that checkout untrusted pull request head code."
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
        checkoutEvidence(risk.step)
      ],
      recommendation: "Avoid checking out untrusted pull request head code in a privileged workflow."
    });
  }
  return findings;
}
function collectUntrustedCheckoutRisks(workflow) {
  if (!workflow) {
    return [];
  }
  const risks = [];
  const secretUsages = collectSecretUsages(workflow);
  for (const job of Object.values(workflow.jobs)) {
    const jobHasWrite = effectiveHasWritePermission(workflow, job);
    const jobHasIdToken = effectivePermission(workflow, job.id, "id-token") === "write";
    const jobHasSecrets = secretUsages.some(
      (usage) => usage.job === void 0 || usage.job === job.id
    );
    for (const step of job.steps) {
      if (!isCheckoutStep(step) || !checkoutUsesPullRequestHead(step)) {
        continue;
      }
      risks.push({
        job,
        step,
        hasWriteToken: jobHasWrite || jobHasIdToken,
        hasSecrets: jobHasSecrets
      });
    }
  }
  return risks;
}
function collectSecretUsages(workflow) {
  if (!workflow) {
    return [];
  }
  const usages = [];
  for (const [name, value] of Object.entries(workflow.parsed.env ?? {})) {
    collectSecretStrings(
      value,
      `workflow env ${name}`,
      void 0,
      false,
      usages
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
          usages
        );
      }
      for (const [name, value] of Object.entries(step.env)) {
        collectSecretStrings(
          value,
          `${stepLabel} env ${name}`,
          job.id,
          false,
          usages
        );
      }
      for (const [name, value] of Object.entries(step.with)) {
        collectSecretStrings(
          value,
          `${stepLabel} input ${name}`,
          job.id,
          false,
          usages
        );
      }
    }
  }
  return usages;
}
function collectSecretStrings(value, location, job, inRun, usages) {
  if (typeof value === "string") {
    if (secretPattern.test(value)) {
      usages.push({
        key: `${job ?? ""}|${location}|${value}`,
        job,
        location,
        value,
        inRun
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(
      (item, index) => collectSecretStrings(item, `${location}[${index}]`, job, inRun, usages)
    );
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectSecretStrings(child, `${location}.${key}`, job, inRun, usages);
    }
  }
}
function permissionWriteFinding(params, scope, before) {
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
        `${permissionLocation(params.job)} now grants \`id-token: write\`.`
      ],
      recommendation: "Confirm this workflow needs OIDC cloud credentials and restrict cloud trust policies to the narrowest repository, branch, and environment claims."
    };
  }
  const severity = sensitiveWriteScopes.get(scope) ?? "medium";
  return {
    id: sensitiveWriteScopes.has(scope) ? "permission-sensitive-write-added" : "permission-elevated",
    title: `GITHUB_TOKEN ${scope} write permission added`,
    severity,
    category: "permission",
    file: params.file,
    job: params.job,
    before,
    after: "write",
    evidence: [
      `${permissionLocation(params.job)} changed \`${scope}\` permission from \`${before}\` to \`write\`.`
    ],
    recommendation: "Keep GITHUB_TOKEN permissions read-only unless this workflow specifically needs write access."
  };
}
function triggerFindingDetails(event) {
  if (event === "pull_request_target") {
    return {
      id: "trigger-pull-request-target-added",
      title: "pull_request_target trigger added",
      severity: "critical",
      recommendation: "Review this workflow carefully. Do not checkout or execute untrusted pull request code in pull_request_target workflows."
    };
  }
  if (event === "workflow_run") {
    return {
      id: "trigger-workflow-run-added",
      title: "workflow_run trigger added",
      severity: "high",
      recommendation: "Confirm downstream workflow execution cannot be influenced by untrusted upstream artifacts or code."
    };
  }
  if (event === "schedule") {
    return {
      id: "trigger-schedule-added",
      title: "Scheduled trigger added",
      severity: "medium",
      recommendation: "Confirm scheduled automation is intentional and has appropriate permissions."
    };
  }
  if (event === "workflow_dispatch") {
    return {
      id: "trigger-workflow-dispatch-added",
      title: "Manual workflow trigger added",
      severity: "low",
      recommendation: "Confirm manual runs are acceptable for this workflow and its permissions."
    };
  }
  return {
    id: "trigger-event-added",
    title: "Workflow trigger added",
    severity: "low",
    recommendation: "Confirm the new trigger matches the intended workflow execution paths."
  };
}
function workflowAddedFinding(workflow) {
  return {
    id: "workflow-added",
    title: "Workflow file added",
    severity: "medium",
    category: "config",
    file: workflow.path,
    evidence: [`New workflow file detected: ${workflow.path}`],
    recommendation: "Review new workflow triggers and permissions before merge."
  };
}
function workflowRemovedFinding(workflow) {
  return {
    id: "workflow-removed",
    title: "Workflow file removed",
    severity: "medium",
    category: "config",
    file: workflow.path,
    evidence: [`Workflow file removed: ${workflow.path}`],
    recommendation: "Ensure the removal is intentional and does not break required checks."
  };
}
function byPath(workflows) {
  return new Map(workflows.map((workflow) => [workflow.path, workflow]));
}
function permissionLocation(job) {
  return job ? `Job \`${job}\`` : "Workflow";
}
function isCheckoutStep(step) {
  return step.uses?.toLowerCase().startsWith("actions/checkout@") ?? false;
}
function checkoutUsesPullRequestHead(step) {
  const values = [
    typeof step.with.ref === "string" ? step.with.ref : "",
    typeof step.with.repository === "string" ? step.with.repository : ""
  ];
  return values.some(
    (value) => prHeadPatterns.some((pattern) => value.includes(pattern))
  );
}
function checkoutEvidence(step) {
  const details = Object.entries(step.with).filter(([key]) => key === "ref" || key === "repository").map(([key, value]) => `${key}: \`${String(value)}\``).join(", ");
  return details ? `Checkout uses pull request head code (${details}).` : "Checkout uses pull request head code.";
}
function riskKey(risk) {
  return `${risk.job.id}|${risk.step.index}|${risk.hasWriteToken}|${risk.hasSecrets}`;
}
function groupBy(values, keyFn) {
  const groups = /* @__PURE__ */ new Map();
  for (const value of values) {
    const key = keyFn(value);
    groups.set(key, [...groups.get(key) ?? [], value]);
  }
  return groups;
}
function actionUsages(workflow) {
  if (!workflow) {
    return [];
  }
  return Object.values(workflow.jobs).flatMap(
    (job) => job.steps.flatMap(
      (step) => step.uses ? [{ job: job.id, step, uses: step.uses }] : []
    )
  );
}
function actionUsageKey(usage) {
  return `${usage.job}|${usage.step.index}|${usage.uses}`;
}
function parseUses(uses) {
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
    ref: uses.slice(atIndex + 1)
  };
}
function isPinnedSha(ref) {
  return /^[a-f0-9]{40}$/i.test(ref ?? "");
}
function isFloatingRef(ref) {
  return ref === void 0 || ref === "" || ref === "main" || ref === "master" || ref === "latest";
}
function isFirstPartyAction(name) {
  return name.startsWith("actions/") || name.startsWith("github/");
}
function isCloudAuthAction(uses) {
  const normalized = parseUses(uses).name.toLowerCase();
  return normalized === "aws-actions/configure-aws-credentials" || normalized === "azure/login" || normalized === "google-github-actions/auth";
}
function floatingActionFinding(file, usage) {
  return actionFinding(file, usage, {
    id: "action-floating-ref-added",
    title: "Action uses a floating ref",
    severity: "high",
    evidence: `Action \`${usage.uses}\` uses a mutable ref.`,
    recommendation: "Use an immutable version or pinned commit SHA for workflow actions."
  });
}
function actionFinding(file, usage, params) {
  return {
    id: params.id,
    title: params.title,
    severity: params.severity,
    category: "supply-chain",
    file,
    job: usage.job,
    evidence: [params.evidence],
    recommendation: params.recommendation
  };
}
function effectivePermission(workflow, jobId, scope) {
  const job = workflow.jobs[jobId];
  if (job && job.permissions.mode !== "unset") {
    return permissionAccess(job.permissions, scope);
  }
  return permissionAccess(workflow.permissions, scope);
}
function effectiveHasWritePermission(workflow, job) {
  if (job.permissions.mode !== "unset") {
    return hasWritePermission(job.permissions);
  }
  return hasWritePermission(workflow.permissions);
}
function filterWidened(base, head) {
  if (base.length === 0) {
    return false;
  }
  if (head.length === 0) {
    return true;
  }
  return head.some((value) => value === "*" || value === "**");
}
function pathFilterRemovedFinding(file, event, filterName) {
  return {
    id: "trigger-path-filter-removed",
    title: `${event} ${filterName} filter removed`,
    severity: "medium",
    category: "trigger",
    file,
    before: filterName,
    after: void 0,
    evidence: [`\`${event}\` removed its \`${filterName}\` filter.`],
    recommendation: "Confirm the workflow should run for the broader set of changed files."
  };
}
function sameStringSet(a, b) {
  return a.length === b.length && a.every((value) => b.includes(value));
}
function formatList(values) {
  if (values.length === 0) {
    return "`<all>`";
  }
  return values.map((value) => `\`${value}\``).join(", ");
}
function imageUsesLatest(image) {
  return image.endsWith(":latest") || !image.includes(":");
}
function isPrivilegedService(image, options) {
  return image?.toLowerCase() === "docker:dind" || options?.toLowerCase().includes("privileged") === true;
}
function isProductionEnvironment(environment) {
  return /^prod(uction)?$/i.test(environment);
}
function isDeployJob(jobId, job) {
  const haystack = `${jobId} ${job.name ?? ""}`.toLowerCase();
  return haystack.includes("deploy") || haystack.includes("release") || haystack.includes("publish");
}
function isGateJobName(jobId) {
  const normalized = jobId.toLowerCase();
  return normalized.includes("test") || normalized.includes("lint") || normalized.includes("build");
}

// src/providers/github-actions/adapter.ts
var GitHubActionsAdapter = class {
  id = "github-actions";
  displayName = "GitHub Actions";
  workflowGlobs = [
    ".github/workflows/*.yml",
    ".github/workflows/*.yaml"
  ];
  async parse(files) {
    const workflows = [];
    const parseFindings = [];
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
          recommendation: "Fix invalid workflow syntax before relying on CI Delta results."
        });
        continue;
      }
      workflows.push(normalizeWorkflow(file.path, file.content, doc.toJSON()));
    }
    return { workflows, parseFindings };
  }
  async diff(base, head) {
    const parseErrorPaths = new Set(
      [...base.parseFindings, ...head.parseFindings].map(
        (finding) => finding.file
      )
    );
    return [
      ...base.parseFindings,
      ...head.parseFindings,
      ...diffWorkflows(
        base.workflows.filter(
          (workflow) => !parseErrorPaths.has(workflow.path)
        ),
        head.workflows.filter(
          (workflow) => !parseErrorPaths.has(workflow.path)
        )
      )
    ];
  }
};

// src/reporters/json.ts
function reportToJson(report) {
  return JSON.stringify(report, null, 2);
}

// src/reporters/markdown.ts
var orderedSeverities = [
  "critical",
  "high",
  "medium",
  "low",
  "info"
];
function reportToMarkdown(report) {
  const lines = [];
  lines.push(
    "## CI Delta Report",
    "",
    `Risk: ${capitalize(report.maxSeverity)}`,
    ""
  );
  if (report.changedFiles.length === 0) {
    lines.push("No GitHub Actions workflow changes detected.");
    return lines.join("\n");
  }
  lines.push("Changed workflow files:");
  for (const file of report.changedFiles) {
    lines.push(`- \`${file}\``);
  }
  for (const severity of orderedSeverities) {
    const matches = report.findings.filter(
      (finding) => finding.severity === severity
    );
    if (matches.length === 0) {
      continue;
    }
    lines.push("", `### ${capitalize(severity)}`, "");
    for (const finding of matches) {
      lines.push(`#### ${finding.title}`, "", `File: \`${finding.file}\``, "");
      if (finding.evidence.length > 0) {
        lines.push("Evidence:");
        for (const entry of finding.evidence) {
          lines.push(`- ${entry}`);
        }
        lines.push("");
      }
      if (finding.recommendation) {
        lines.push(`Recommendation: ${finding.recommendation}`, "");
      }
    }
  }
  lines.push("### Summary", "");
  for (const severity of orderedSeverities) {
    lines.push(`- ${capitalize(severity)}: ${report.summary[severity]}`);
  }
  return lines.join("\n").trimEnd();
}
function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export {
  compareSeverity,
  maxSeverity,
  getSummary,
  meetsThreshold,
  buildReport,
  compareSources,
  changedFilePaths,
  normalizeWorkflow,
  normalizeTriggers,
  normalizePermissions,
  permissionAccess,
  hasWritePermission,
  explicitWriteScopes,
  normalizeJobs,
  stringList,
  asRecord,
  stringValue,
  GitHubActionsAdapter,
  reportToJson,
  reportToMarkdown
};

import { renderRule, type GitLabRule } from "./normalize.js";

/**
 * Semantic comparison of GitLab `rules:` lists.
 *
 * GitLab evaluates rules in order and uses the first rule that matches. The
 * comparison aligns base and head rules (longest common subsequence), then
 * reasons about each inserted, removed, modified, or reordered rule:
 *
 * - an inserted rule that can run the job (`when` other than `never`) adds a
 *   new way to run it, especially when it sits ahead of a deny rule;
 * - a removed rule lets the pipelines it matched fall through to later rules,
 *   which widens when a later rule has a more permissive outcome (removing a
 *   `when: never` deny rule is the common case);
 * - a modified rule widens when its outcome becomes more permissive, its `if:`
 *   loses a clause or becomes a presence check, or its `changes:`/`exists:`
 *   guard is removed or matches more paths;
 * - anything else that changed but cannot be proven narrower is reported as a
 *   change so a reviewer looks at it.
 *
 * It never evaluates expressions against real pipeline variables.
 */

export interface RuleComparison {
  widened: string[];
  changed: string[];
}

export interface CompareRulesParams {
  /** Evidence prefix, such as "Job `deploy`" or "Workflow". */
  label: string;
  /** "job" or "pipeline", used in evidence wording. */
  subject: string;
  base: GitLabRule[];
  head: GitLabRule[];
  /** Outcome of a matching rule with no `when:` (job-level `when` or default). */
  baseDefaultWhen: string;
  headDefaultWhen: string;
}

interface EffectiveRule {
  rule: GitLabRule;
  when: string;
  cond: string;
  key: string;
}

const outcomeRank: Record<string, number> = {
  never: 0,
  manual: 1,
  delayed: 2,
  on_failure: 2,
  on_success: 3,
  always: 4,
};

export function outcomeRankOf(when: string): number {
  return outcomeRank[when] ?? 3;
}

export function compareRules(params: CompareRulesParams): RuleComparison {
  const base = params.base.map((rule) =>
    effective(rule, params.baseDefaultWhen),
  );
  const head = params.head.map((rule) =>
    effective(rule, params.headDefaultWhen),
  );
  const result: RuleComparison = { widened: [], changed: [] };

  if (
    base.length === head.length &&
    base.every((rule, index) => rule.key === head[index]?.key)
  ) {
    return result;
  }

  if (sameMultiset(base, head)) {
    return compareReordered(params, base, head);
  }

  const ops = align(base, head);
  let headCursor = 0;
  let index = 0;
  while (index < ops.length) {
    const op = ops[index];
    if (op?.type === "same") {
      headCursor = op.head + 1;
      index += 1;
      continue;
    }

    const removed: number[] = [];
    const inserted: number[] = [];
    while (index < ops.length && ops[index]?.type !== "same") {
      const gapOp = ops[index];
      if (gapOp?.type === "removed") {
        removed.push(gapOp.base);
      } else if (gapOp?.type === "inserted") {
        inserted.push(gapOp.head);
      }
      index += 1;
    }

    const pairs = Math.min(removed.length, inserted.length);
    for (let pair = 0; pair < pairs; pair += 1) {
      const baseRule = base[removed[pair] ?? -1];
      const headIndex = inserted[pair] ?? -1;
      const headRule = head[headIndex];
      if (baseRule && headRule) {
        compareModified(params, baseRule, headRule, headIndex, head, result);
      }
    }

    for (const baseIndex of removed.slice(pairs)) {
      const baseRule = base[baseIndex];
      if (baseRule) {
        compareRemoved(params, baseRule, head.slice(headCursor), result);
      }
    }

    for (const headIndex of inserted.slice(pairs)) {
      compareInserted(params, headIndex, head, result);
    }

    headCursor = (inserted[inserted.length - 1] ?? headCursor - 1) + 1;
  }

  if (result.widened.length === 0 && result.changed.length === 0) {
    return result;
  }

  return dedupe(result);
}

function effective(rule: GitLabRule, defaultWhen: string): EffectiveRule {
  const when = rule.when ?? defaultWhen;
  const cond = JSON.stringify([
    rule.ifClause ?? null,
    rule.hasChanges ? rule.changes : null,
    rule.compareTo ?? null,
    rule.hasExists ? rule.exists : null,
  ]);
  return { rule, when, cond, key: `${cond}|${when}` };
}

function isUnconditional(rule: GitLabRule): boolean {
  return !rule.ifClause && !rule.hasChanges && !rule.hasExists;
}

function show(rule: EffectiveRule): string {
  return `\`${renderRule(rule.rule)}\``;
}

function compareReordered(
  params: CompareRulesParams,
  base: EffectiveRule[],
  head: EffectiveRule[],
): RuleComparison {
  const result: RuleComparison = { widened: [], changed: [] };
  const headPosition = new Map<string, number>();
  head.forEach((rule, index) => {
    if (!headPosition.has(rule.key)) {
      headPosition.set(rule.key, index);
    }
  });

  for (let earlier = 0; earlier < base.length; earlier += 1) {
    for (let later = earlier + 1; later < base.length; later += 1) {
      const first = base[earlier];
      const second = base[later];
      if (!first || !second || first.key === second.key) {
        continue;
      }

      const firstHead = headPosition.get(first.key) ?? 0;
      const secondHead = headPosition.get(second.key) ?? 0;
      if (
        secondHead < firstHead &&
        outcomeRankOf(second.when) > outcomeRankOf(first.when)
      ) {
        const what =
          first.when === "never" ? "deny rule" : `\`when: ${first.when}\` rule`;
        result.widened.push(
          `${params.label} now evaluates ${show(second)} before the ${what} ${show(first)}.`,
        );
      }
    }
  }

  if (result.widened.length === 0) {
    result.changed.push(
      `${params.label} reordered its rules from ${base.map(show).join(", ")} to ${head.map(show).join(", ")}.`,
    );
  }

  return result;
}

function compareRemoved(
  params: CompareRulesParams,
  removed: EffectiveRule,
  following: EffectiveRule[],
  result: RuleComparison,
): void {
  const fallthrough = reachable(following).find(
    (rule) => outcomeRankOf(rule.when) > outcomeRankOf(removed.when),
  );
  if (!fallthrough) {
    return;
  }

  const what =
    removed.when === "never"
      ? `deny rule ${show(removed)}`
      : `rule ${show(removed)}`;
  const outcome = fallthrough.rule.when
    ? ""
    : ` (\`when: ${fallthrough.when}\`)`;
  result.widened.push(
    `${params.label} removed ${what}; pipelines it matched can now fall through to ${show(fallthrough)}${outcome}.`,
  );
}

function compareInserted(
  params: CompareRulesParams,
  headIndex: number,
  head: EffectiveRule[],
  result: RuleComparison,
): void {
  const rule = head[headIndex];
  if (!rule || rule.when === "never") {
    return;
  }

  const before = head.slice(0, headIndex);
  if (
    before.some(
      (candidate) =>
        isUnconditional(candidate.rule) || candidate.cond === rule.cond,
    )
  ) {
    return;
  }

  const after = head.slice(headIndex + 1);
  if (
    after.some(
      (candidate) =>
        candidate.cond === rule.cond &&
        outcomeRankOf(candidate.when) >= outcomeRankOf(rule.when),
    )
  ) {
    return;
  }

  if (isUnconditional(rule.rule)) {
    result.widened.push(
      `${params.label} added an unconditional rule (${show(rule)}).`,
    );
    return;
  }

  const deny = after.find((candidate) => candidate.when === "never");
  const position = deny ? ` ahead of deny rule ${show(deny)}` : "";
  result.widened.push(
    `${params.label} added rule ${show(rule)}${position}, which can run the ${params.subject}${rule.rule.when ? "" : ` (\`when: ${rule.when}\`)`}.`,
  );
}

function compareModified(
  params: CompareRulesParams,
  base: EffectiveRule,
  head: EffectiveRule,
  headIndex: number,
  headRules: EffectiveRule[],
  result: RuleComparison,
): void {
  const before = headRules.slice(0, headIndex);
  if (before.some((candidate) => isUnconditional(candidate.rule))) {
    return;
  }

  const prefix = `${params.label} changed rule ${show(base)} to ${show(head)}`;
  const widened: string[] = [];
  const changed: string[] = [];

  if (base.when === "never" && head.when === "never") {
    compareDenyRules(base.rule, head.rule, widened, changed);
  } else if (outcomeRankOf(head.when) > outcomeRankOf(base.when)) {
    widened.push(`\`when\` went from \`${base.when}\` to \`${head.when}\``);
  } else if (head.when !== base.when && head.when !== "never") {
    changed.push(`\`when\` went from \`${base.when}\` to \`${head.when}\``);
  }

  if (head.when !== "never" && base.when !== "never") {
    const ifResult = compareIf(base.rule.ifClause, head.rule.ifClause);
    if (ifResult.kind === "widened") {
      widened.push(ifResult.reason);
    } else if (ifResult.kind === "changed") {
      changed.push(ifResult.reason);
    }

    comparePaths(
      "changes",
      base.rule.hasChanges,
      head.rule.hasChanges,
      base.rule.changes,
      head.rule.changes,
      widened,
    );
    comparePaths(
      "exists",
      base.rule.hasExists,
      head.rule.hasExists,
      base.rule.exists,
      head.rule.exists,
      widened,
    );

    if (
      base.rule.hasChanges &&
      head.rule.hasChanges &&
      base.rule.compareTo !== head.rule.compareTo
    ) {
      changed.push(
        `\`changes:compare_to\` went from \`${base.rule.compareTo ?? "default"}\` to \`${head.rule.compareTo ?? "default"}\``,
      );
    }
  } else if (head.when !== "never") {
    // A deny rule became a rule that can run the job; the outcome change above
    // already says so. Condition edits on top of that are reported as context.
    const ifResult = compareIf(base.rule.ifClause, head.rule.ifClause);
    if (ifResult.kind === "widened" || ifResult.kind === "changed") {
      widened.push(ifResult.reason);
    }
  }

  if (widened.length > 0) {
    result.widened.push(`${prefix}: ${widened.join("; ")}.`);
  } else if (changed.length > 0) {
    result.changed.push(`${prefix}: ${changed.join("; ")}.`);
  }
}

/**
 * Deny rules invert the usual reasoning: a deny rule that matches fewer
 * pipelines lets the job run in more of them.
 */
function compareDenyRules(
  base: GitLabRule,
  head: GitLabRule,
  widened: string[],
  changed: string[],
): void {
  const ifResult = compareIf(base.ifClause, head.ifClause);
  if (ifResult.kind === "narrowed") {
    widened.push("the deny rule's `if:` now matches fewer pipelines");
  } else if (ifResult.kind === "changed") {
    changed.push(ifResult.reason);
  }

  for (const [name, baseHas, headHas, basePaths, headPaths] of [
    ["changes", base.hasChanges, head.hasChanges, base.changes, head.changes],
    ["exists", base.hasExists, head.hasExists, base.exists, head.exists],
  ] as const) {
    if (!baseHas && headHas) {
      widened.push(`the deny rule now only applies when \`${name}\` matches`);
    } else if (baseHas && headHas) {
      const dropped = basePaths.filter((entry) => !headPaths.includes(entry));
      if (dropped.length > 0) {
        widened.push(
          `the deny rule's \`${name}\` no longer matches ${dropped.map(code).join(", ")}`,
        );
      }
    }
  }
}

function comparePaths(
  name: string,
  baseHas: boolean,
  headHas: boolean,
  basePaths: string[],
  headPaths: string[],
  widened: string[],
): void {
  if (baseHas && !headHas) {
    widened.push(`the \`${name}\` guard was removed`);
    return;
  }

  if (!baseHas || !headHas) {
    return;
  }

  const added = headPaths.filter((entry) => !basePaths.includes(entry));
  if (added.length > 0) {
    widened.push(
      `\`${name}\` now also matches ${added.map((entry) => `\`${entry}\``).join(", ")}`,
    );
  }
}

function reachable(rules: EffectiveRule[]): EffectiveRule[] {
  const result: EffectiveRule[] = [];
  for (const rule of rules) {
    result.push(rule);
    if (isUnconditional(rule.rule)) {
      break;
    }
  }
  return result;
}

function sameMultiset(base: EffectiveRule[], head: EffectiveRule[]): boolean {
  if (base.length !== head.length) {
    return false;
  }

  const left = base.map((rule) => rule.key).sort();
  const right = head.map((rule) => rule.key).sort();
  return left.every((key, index) => key === right[index]);
}

type AlignOp =
  | { type: "same"; base: number; head: number }
  | { type: "removed"; base: number }
  | { type: "inserted"; head: number };

function align(base: EffectiveRule[], head: EffectiveRule[]): AlignOp[] {
  const rows = base.length + 1;
  const cols = head.length + 1;
  const table: number[][] = Array.from({ length: rows }, () =>
    new Array<number>(cols).fill(0),
  );

  for (let i = base.length - 1; i >= 0; i -= 1) {
    for (let j = head.length - 1; j >= 0; j -= 1) {
      const row = table[i] as number[];
      row[j] =
        base[i]?.key === head[j]?.key
          ? (table[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const ops: AlignOp[] = [];
  let i = 0;
  let j = 0;
  while (i < base.length && j < head.length) {
    if (base[i]?.key === head[j]?.key) {
      ops.push({ type: "same", base: i, head: j });
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      ops.push({ type: "removed", base: i });
      i += 1;
    } else {
      ops.push({ type: "inserted", head: j });
      j += 1;
    }
  }
  while (i < base.length) {
    ops.push({ type: "removed", base: i });
    i += 1;
  }
  while (j < head.length) {
    ops.push({ type: "inserted", head: j });
    j += 1;
  }

  return ops;
}

function dedupe(result: RuleComparison): RuleComparison {
  return {
    widened: [...new Set(result.widened)],
    changed: [...new Set(result.changed)],
  };
}

export type IfComparison =
  | { kind: "same" }
  | { kind: "narrowed" }
  | { kind: "widened"; reason: string }
  | { kind: "changed"; reason: string };

/**
 * Compares two `rules:if` expressions without evaluating them. It recognizes
 * a removed condition, a dropped `&&` clause, an added `||` alternative, and a
 * comparison relaxed to a presence check (`$VAR == "x"` to `$VAR`). Any other
 * difference is reported as a change.
 */
export function compareIf(
  base: string | undefined,
  head: string | undefined,
): IfComparison {
  if (base === head) {
    return { kind: "same" };
  }

  if (base && !head) {
    return {
      kind: "widened",
      reason: `the \`if: ${base}\` condition was removed`,
    };
  }

  if (!base || !head) {
    return { kind: "narrowed" };
  }

  const baseOr = splitTopLevel(base, "||");
  const headOr = splitTopLevel(head, "||");
  if (strictSubset(baseOr, headOr)) {
    const added = headOr.filter((entry) => !baseOr.includes(entry));
    return {
      kind: "widened",
      reason: `\`if:\` gained the \`||\` alternative ${added.map(code).join(", ")}`,
    };
  }

  if (strictSubset(headOr, baseOr)) {
    return { kind: "narrowed" };
  }

  if (baseOr.length === 1 && headOr.length === 1) {
    const baseAnd = splitTopLevel(base, "&&");
    const headAnd = splitTopLevel(head, "&&");
    if (strictSubset(headAnd, baseAnd)) {
      const dropped = baseAnd.filter((entry) => !headAnd.includes(entry));
      return {
        kind: "widened",
        reason: `\`if:\` dropped the \`&&\` clause ${dropped.map(code).join(", ")}`,
      };
    }

    if (strictSubset(baseAnd, headAnd)) {
      return { kind: "narrowed" };
    }

    const baseRest = baseAnd.filter((entry) => !headAnd.includes(entry));
    const headRest = headAnd.filter((entry) => !baseAnd.includes(entry));
    const relaxed = headRest.map((clause) => {
      const variable = presenceVariable(clause);
      return variable
        ? baseRest.find((candidate) => comparedVariable(candidate) === variable)
        : undefined;
    });
    if (
      headRest.length > 0 &&
      headRest.length <= baseRest.length &&
      relaxed.every(Boolean)
    ) {
      const pairs = headRest.map(
        (clause, index) => `${code(relaxed[index] ?? "")} to ${code(clause)}`,
      );
      return {
        kind: "widened",
        reason: `\`if:\` relaxed ${pairs.join(", ")}, which matches any non-empty value`,
      };
    }
  }

  return {
    kind: "changed",
    reason: `\`if:\` changed from \`${base}\` to \`${head}\` and ci-delta cannot prove it is narrower`,
  };
}

function code(value: string): string {
  return `\`${value}\``;
}

function strictSubset(small: string[], large: string[]): boolean {
  return (
    small.length < large.length && small.every((entry) => large.includes(entry))
  );
}

const variablePattern = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;

function presenceVariable(clause: string): string | undefined {
  return variablePattern.exec(clause)?.[1];
}

function comparedVariable(clause: string): string | undefined {
  const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?\s*(==|=~)/.exec(clause);
  return match?.[1];
}

/**
 * Splits an expression on a top-level operator, ignoring operators inside
 * parentheses, quoted strings, and regular expression literals.
 */
export function splitTopLevel(expression: string, operator: string): string[] {
  const parts: string[] = [];
  const text = stripOuterParens(expression.trim());
  let depth = 0;
  let quote: string | null = null;
  let inRegex = false;
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (inRegex) {
      if (char === "\\") {
        index += 1;
      } else if (char === "/") {
        inRegex = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "/" && /[=!]~\s*$/.test(text.slice(0, index))) {
      inRegex = true;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (depth === 0 && text.startsWith(operator, index)) {
      parts.push(text.slice(start, index));
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  parts.push(text.slice(start));

  return parts
    .map((part) => stripOuterParens(part.trim()).replace(/\s+/g, " "))
    .filter(Boolean);
}

function stripOuterParens(value: string): string {
  let current = value.trim();
  while (current.startsWith("(") && current.endsWith(")")) {
    let depth = 0;
    let wrapsAll = true;
    for (let index = 0; index < current.length; index += 1) {
      if (current[index] === "(") {
        depth += 1;
      } else if (current[index] === ")") {
        depth -= 1;
        if (depth === 0 && index < current.length - 1) {
          wrapsAll = false;
          break;
        }
      }
    }
    if (!wrapsAll) {
      break;
    }
    current = current.slice(1, -1).trim();
  }
  return current;
}

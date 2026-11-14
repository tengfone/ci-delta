/**
 * Heuristics for spotting credential-like variable references in GitLab CI
 * scripts and variable values.
 *
 * A reference is flagged when its name looks like a credential (a `TOKEN`,
 * `PASSWORD`, `SECRET`, `CREDENTIALS`, `JWT`, private/access key segment, or a
 * trailing `KEY` such as `DEPLOY_KEY` or `GITLAB_API_KEY`).
 *
 * GitLab's predefined `CI_*` variables are ignored, except for the few that
 * carry a credential: the job token (`CI_JOB_TOKEN`, also embedded in
 * `CI_REPOSITORY_URL`), the deprecated `CI_JOB_JWT*` tokens, and the registry,
 * deploy-token, and dependency-proxy passwords. Those are short-lived and scoped
 * to the job, so they are reported as "predefined" and graded lower than
 * user-defined secrets.
 */

export interface SecretRef {
  name: string;
  display: string;
  predefined: boolean;
}

const secretNamePattern =
  /(?:^|_)(?:TOKENS?|PASSWORDS?|PASSWD|PASS|SECRETS?|CREDENTIALS?|CREDS|JWT|APIKEY|PRIVATE_KEY|ACCESS_KEY)(?:_|$)|(?:^|_)KEYS?$/;

const benignKeyNames =
  /(?:^|_)(?:CACHE|SORT|PARTITION|PRIMARY|FOREIGN|LOOKUP|ROUTING|IDEMPOTENCY|PUBLIC|GPG_PUBLIC)_KEYS?$/;

const sensitivePredefined = new Set([
  "CI_JOB_TOKEN",
  "CI_JOB_JWT",
  "CI_JOB_JWT_V1",
  "CI_JOB_JWT_V2",
  "CI_REGISTRY_PASSWORD",
  "CI_DEPLOY_PASSWORD",
  "CI_DEPENDENCY_PROXY_PASSWORD",
  "CI_REPOSITORY_URL",
]);

export function isSecretLikeName(name: string): boolean {
  const upper = name.toUpperCase();
  if (upper.startsWith("CI_")) {
    return sensitivePredefined.has(upper);
  }

  return secretNamePattern.test(upper) && !benignKeyNames.test(upper);
}

export function secretRefMatches(text: string | undefined): SecretRef[] {
  if (!text) {
    return [];
  }

  const matches: SecretRef[] = [];
  const referencePattern = /(?<!\$)\$(\{)?([A-Za-z_][A-Za-z0-9_]*)(\})?/g;
  for (const match of text.matchAll(referencePattern)) {
    const name = match[2];
    if (!name || !isSecretLikeName(name)) {
      continue;
    }

    const braced = match[1] === "{" && match[3] === "}";
    matches.push({
      name,
      display: braced ? `\${${name}}` : `$${name}`,
      predefined: name.toUpperCase().startsWith("CI_"),
    });
  }

  return matches;
}

/** References in `after` whose names do not appear in `before`. */
export function newSecretRefs(
  before: string | undefined,
  after: string | undefined,
): SecretRef[] {
  const previous = new Set(secretRefMatches(before).map((ref) => ref.name));
  const added = new Map<string, SecretRef>();

  for (const ref of secretRefMatches(after)) {
    if (!previous.has(ref.name) && !added.has(ref.name)) {
      added.set(ref.name, ref);
    }
  }

  return [...added.values()];
}

export function formatRefs(refs: SecretRef[]): string {
  return refs.map((ref) => `\`${ref.display}\``).join(", ");
}

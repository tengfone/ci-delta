export type CiProviderId = "github-actions" | "gitlab-ci";

export function resolveProviderId(input: string): CiProviderId | null {
  switch (input) {
    case "github-actions":
    case "gha":
    case "github":
      return "github-actions";
    case "gitlab-ci":
    case "gitlab":
      return "gitlab-ci";
    default:
      return null;
  }
}

import type { ProviderAdapter } from "../core/types.js";
import { GitHubActionsAdapter } from "./github-actions/adapter.js";
import { GitLabCiAdapter } from "./gitlab-ci/adapter.js";

export type CiProviderId = "github-actions" | "gitlab-ci";

export const providerAliases = "github-actions, gha, github, gitlab-ci, gitlab";

export function resolveProviderId(input: string): CiProviderId | null {
  switch (input.trim().toLowerCase()) {
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

export function createProviderAdapter(
  id: CiProviderId,
): ProviderAdapter<unknown> {
  switch (id) {
    case "github-actions":
      return new GitHubActionsAdapter() as ProviderAdapter<unknown>;
    case "gitlab-ci":
      return new GitLabCiAdapter() as ProviderAdapter<unknown>;
    default: {
      const unsupported: never = id;
      throw new Error(`Unsupported provider: ${String(unsupported)}`);
    }
  }
}

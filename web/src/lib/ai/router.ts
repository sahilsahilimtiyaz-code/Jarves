/** Role-based model selection. Pure so the routing rules are testable. */
import type { ProviderConfig, RoleKey } from "./types";

/**
 * Ordered chain for a request.
 *
 * Fallbacks are only included when the caller explicitly allows them AND the
 * config opted in — that prevents an accidental switch from a free model to a
 * paid one (or a silent spend on another vendor).
 */
export function selectChain(
  configs: ProviderConfig[],
  role: RoleKey,
  allowFallback = false,
): ProviderConfig[] {
  const enabled = configs.filter((config) => config.enabled && config.model.trim());
  if (role === "fallback") return [];
  const primary = enabled.filter((config) => config.roles.includes(role));
  const fallbacks = allowFallback
    ? enabled.filter(
        (config) =>
          config.allowFallback &&
          config.roles.includes("fallback") &&
          !primary.some((candidate) => candidate.id === config.id),
      )
    : [];
  return [...primary, ...fallbacks];
}

export function describeConfig(config: ProviderConfig | null | undefined): string {
  if (!config) return "None";
  return `${config.label} · ${config.model}`;
}

/** The config used when the owner has not chosen a role explicitly. */
export function defaultConfig(configs: ProviderConfig[]): ProviderConfig | null {
  return (
    configs.find((config) => config.enabled && config.roles.includes("default")) ||
    configs.find((config) => config.enabled) ||
    null
  );
}

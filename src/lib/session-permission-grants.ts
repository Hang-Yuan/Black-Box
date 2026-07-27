import {
  safeSessionPermissionSuggestions,
  type PermissionUpdate,
} from './permission-suggestions';

const grantsByStdin = new Map<string, Set<string>>();

function grantAtoms(updates: readonly PermissionUpdate[]): string[] {
  const atoms: string[] = [];
  for (const update of updates) {
    if (update.type === 'addRules') {
      for (const rule of update.rules) {
        atoms.push(`rule\u0000${rule.toolName}\u0000${rule.ruleContent ?? ''}`);
      }
    } else if (update.type === 'addDirectories') {
      for (const directory of update.directories) atoms.push(`directory\u0000${directory}`);
    }
  }
  return atoms;
}

/** Register exact CLI-structured grants for one live stdin process. */
export function registerSessionPermissionGrants(
  stdinId: string,
  suggestions: unknown,
): PermissionUpdate[] {
  const safe = safeSessionPermissionSuggestions(suggestions);
  if (!stdinId || safe.length === 0) return [];
  const grants = grantsByStdin.get(stdinId) ?? new Set<string>();
  for (const atom of grantAtoms(safe)) grants.add(atom);
  grantsByStdin.set(stdinId, grants);
  return safe;
}

/**
 * Return downscoped updates only when every exact rule/directory in the new
 * CLI request was already approved for this same stdin process.
 */
export function matchingSessionPermissionGrants(
  stdinId: string,
  suggestions: unknown,
): PermissionUpdate[] {
  const safe = safeSessionPermissionSuggestions(suggestions);
  const grants = grantsByStdin.get(stdinId);
  if (!grants || safe.length === 0) return [];
  return grantAtoms(safe).every((atom) => grants.has(atom)) ? safe : [];
}

/** Revoke every in-memory grant when its CLI process stops or is replaced. */
export function clearSessionPermissionGrants(stdinId: string): void {
  grantsByStdin.delete(stdinId);
}

export function clearAllSessionPermissionGrantsForTests(): void {
  grantsByStdin.clear();
}

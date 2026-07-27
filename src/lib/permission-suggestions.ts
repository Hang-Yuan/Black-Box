export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg';

export interface PermissionRuleValue {
  toolName: string;
  ruleContent?: string;
}

export type PermissionUpdate =
  | {
      type: 'addRules' | 'replaceRules' | 'removeRules';
      rules: PermissionRuleValue[];
      behavior: 'allow' | 'deny' | 'ask';
      destination: PermissionUpdateDestination;
    }
  | {
      type: 'setMode';
      mode: string;
      destination: PermissionUpdateDestination;
    }
  | {
      type: 'addDirectories' | 'removeDirectories';
      directories: string[];
      destination: PermissionUpdateDestination;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Return the complete CLI suggestion set only when every update is a narrow,
 * additive allow rule that can be safely downscoped to the current session.
 *
 * Claude CLI commonly suggests a persistent localSettings rule together with
 * a session directory grant. PermissionUpdate lets the caller choose the
 * destination, so Black Box rewrites every accepted additive update to
 * `session`. Dropping one update could make the apparent scope differ from the
 * rule actually applied, so one unsafe or malformed member still hides the
 * scoped action.
 */
export function safeSessionPermissionSuggestions(value: unknown): PermissionUpdate[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return [];

  const updates: PermissionUpdate[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return [];
    if (!['userSettings', 'projectSettings', 'localSettings', 'session'].includes(
      String(candidate.destination),
    )) return [];

    if (candidate.type === 'addRules') {
      if (candidate.behavior !== 'allow' || !Array.isArray(candidate.rules)) return [];
      if (candidate.rules.length === 0 || candidate.rules.length > 64) return [];
      const rules: PermissionRuleValue[] = [];
      for (const rawRule of candidate.rules) {
        if (!isRecord(rawRule)) return [];
        const toolName = typeof rawRule.toolName === 'string' ? rawRule.toolName.trim() : '';
        const ruleContent = rawRule.ruleContent;
        if (!toolName || toolName.length > 256) return [];
        if (ruleContent !== undefined && typeof ruleContent !== 'string') return [];
        if (typeof ruleContent === 'string' && ruleContent.length > 2_048) return [];
        rules.push({
          toolName,
          ...(typeof ruleContent === 'string' && ruleContent.length > 0 ? { ruleContent } : {}),
        });
      }
      updates.push({ type: 'addRules', rules, behavior: 'allow', destination: 'session' });
      continue;
    }

    if (candidate.type === 'addDirectories') {
      if (!Array.isArray(candidate.directories)) return [];
      if (candidate.directories.length === 0 || candidate.directories.length > 64) return [];
      const directories = candidate.directories.map((directory) => (
        typeof directory === 'string' ? directory.trim() : ''
      ));
      if (directories.some((directory) => !directory || directory.length > 2_048)) return [];
      updates.push({ type: 'addDirectories', directories, destination: 'session' });
      continue;
    }

    // Persistent destinations, mode changes, replace/remove operations and
    // future unknown variants require a dedicated review surface.
    return [];
  }

  return updates;
}

export function summarizePermissionSuggestions(
  updates: readonly PermissionUpdate[],
): string[] {
  const labels: string[] = [];
  for (const update of updates) {
    if (update.type === 'addRules') {
      for (const rule of update.rules) {
        labels.push(rule.ruleContent
          ? `${rule.toolName}(${rule.ruleContent})`
          : rule.toolName);
      }
    } else if (update.type === 'addDirectories') {
      labels.push(...update.directories);
    }
  }
  return labels;
}

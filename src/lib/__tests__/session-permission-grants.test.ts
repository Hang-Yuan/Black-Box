import { afterEach, describe, expect, it } from 'vitest';
import {
  clearAllSessionPermissionGrantsForTests,
  clearSessionPermissionGrants,
  matchingSessionPermissionGrants,
  registerSessionPermissionGrants,
} from '../session-permission-grants';

const observedCliSuggestions = [
  {
    type: 'addRules',
    behavior: 'allow',
    destination: 'localSettings',
    rules: [{ toolName: 'Bash', ruleContent: "printf '%s\\n' MARKER >> result.txt" }],
  },
  {
    type: 'addDirectories',
    destination: 'session',
    directories: ['/tmp/isolated'],
  },
];

afterEach(clearAllSessionPermissionGrantsForTests);

describe('live session permission grants', () => {
  it('matches the same CLI rule only for the owning stdin process', () => {
    const registered = registerSessionPermissionGrants('stdin-a', observedCliSuggestions);
    expect(registered.every((update) => update.destination === 'session')).toBe(true);
    expect(matchingSessionPermissionGrants('stdin-a', observedCliSuggestions)).toEqual(registered);
    expect(matchingSessionPermissionGrants('stdin-b', observedCliSuggestions)).toEqual([]);
  });

  it('does not widen one exact Bash rule to another command', () => {
    registerSessionPermissionGrants('stdin-a', observedCliSuggestions);
    const different = structuredClone(observedCliSuggestions);
    different[0]!.rules![0]!.ruleContent = 'rm -rf unrelated';
    expect(matchingSessionPermissionGrants('stdin-a', different)).toEqual([]);
  });

  it('requires the complete rule and directory set', () => {
    registerSessionPermissionGrants('stdin-a', [observedCliSuggestions[0]]);
    expect(matchingSessionPermissionGrants('stdin-a', observedCliSuggestions)).toEqual([]);
  });

  it('revokes grants when the process is cleared', () => {
    registerSessionPermissionGrants('stdin-a', observedCliSuggestions);
    clearSessionPermissionGrants('stdin-a');
    expect(matchingSessionPermissionGrants('stdin-a', observedCliSuggestions)).toEqual([]);
  });

  it('never registers mode changes or destructive permission updates', () => {
    const unsafe = [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }];
    expect(registerSessionPermissionGrants('stdin-a', unsafe)).toEqual([]);
    expect(matchingSessionPermissionGrants('stdin-a', unsafe)).toEqual([]);
  });
});

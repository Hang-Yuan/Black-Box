import { describe, expect, it } from 'vitest';
import {
  safeSessionPermissionSuggestions,
  summarizePermissionSuggestions,
} from '../permission-suggestions';

describe('safe session permission suggestions', () => {
  it('keeps a complete additive session rule and directory set', () => {
    const input = [
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [
          { toolName: 'Bash', ruleContent: 'git status:*' },
          { toolName: 'Read' },
        ],
      },
      {
        type: 'addDirectories',
        destination: 'session',
        directories: ['/tmp/isolated-scope'],
      },
    ];

    const safe = safeSessionPermissionSuggestions(input);
    expect(safe).toEqual(input);
    expect(summarizePermissionSuggestions(safe)).toEqual([
      'Bash(git status:*)',
      'Read',
      '/tmp/isolated-scope',
    ]);
  });

  it.each(['userSettings', 'projectSettings', 'localSettings'])(
    'downscopes an additive %s rule to the current session',
    (destination) => {
      expect(safeSessionPermissionSuggestions([{
        type: 'addRules',
        behavior: 'allow',
        destination,
        rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }],
      }])).toEqual([{
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }],
      }]);
    },
  );

  it('rejects a launch-argument destination', () => {
    expect(safeSessionPermissionSuggestions([{
      type: 'addRules',
      behavior: 'allow',
      destination: 'cliArg',
      rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }],
    }])).toEqual([]);
  });

  it('downscopes the exact mixed shape emitted by Claude CLI', () => {
    expect(safeSessionPermissionSuggestions([
      {
        type: 'addRules', behavior: 'allow', destination: 'localSettings',
        rules: [{ toolName: 'Bash', ruleContent: "printf '%s\\n' 'MARKER' >> result.txt" }],
      },
      {
        type: 'addDirectories', destination: 'session', directories: ['/tmp/isolated'],
      },
    ])).toEqual([
      {
        type: 'addRules', behavior: 'allow', destination: 'session',
        rules: [{ toolName: 'Bash', ruleContent: "printf '%s\\n' 'MARKER' >> result.txt" }],
      },
      {
        type: 'addDirectories', destination: 'session', directories: ['/tmp/isolated'],
      },
    ]);
  });

  it('rejects mode, replace, remove and non-allow updates', () => {
    const unsafe = [
      { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
      {
        type: 'replaceRules', behavior: 'allow', destination: 'session',
        rules: [{ toolName: 'Bash' }],
      },
      {
        type: 'removeRules', behavior: 'allow', destination: 'session',
        rules: [{ toolName: 'Bash' }],
      },
      {
        type: 'addRules', behavior: 'deny', destination: 'session',
        rules: [{ toolName: 'Bash' }],
      },
      { type: 'removeDirectories', destination: 'session', directories: ['/tmp'] },
    ];

    for (const update of unsafe) {
      expect(safeSessionPermissionSuggestions([update])).toEqual([]);
    }
  });

  it('hides the scoped action when any member of the full suggestion set is unsafe', () => {
    expect(safeSessionPermissionSuggestions([
      {
        type: 'addRules', behavior: 'allow', destination: 'session',
        rules: [{ toolName: 'Read' }],
      },
      {
        type: 'addRules', behavior: 'allow', destination: 'cliArg',
        rules: [{ toolName: 'Write' }],
      },
    ])).toEqual([]);
  });

  it('rejects malformed or empty suggestions', () => {
    expect(safeSessionPermissionSuggestions(undefined)).toEqual([]);
    expect(safeSessionPermissionSuggestions([])).toEqual([]);
    expect(safeSessionPermissionSuggestions([{
      type: 'addRules', behavior: 'allow', destination: 'session', rules: [],
    }])).toEqual([]);
    expect(safeSessionPermissionSuggestions([{
      type: 'addDirectories', destination: 'session', directories: ['  '],
    }])).toEqual([]);
  });
});

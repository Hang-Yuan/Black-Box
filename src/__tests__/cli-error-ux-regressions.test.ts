import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyCliMaintenanceError } from '../components/settings/settingsUtils';

const root = resolve(import.meta.dirname, '..');
const cliTab = readFileSync(resolve(root, 'components/settings/CliTab.tsx'), 'utf8');
const i18n = readFileSync(resolve(root, 'lib/i18n.ts'), 'utf8');

describe('CLI maintenance error experience', () => {
  it.each([
    ['TelemetrySafeError: Download timed out: exceeded the total deadline', 'network'],
    ['CLI_UPDATE_BLOCKED_AUTOMATION', 'blockedAutomation'],
    ['CLI_UPDATE_BLOCKED_SESSIONS:session-a', 'blockedSessions'],
    ['Selected SDK runtime is missing or broken', 'runtime'],
    ['EACCES: permission denied', 'permission'],
    ['This installation must be updated by its owner. Run in a terminal: brew upgrade', 'owner'],
    ['an unrecognized maintenance failure', 'unknown'],
  ] as const)('classifies %s as %s and preserves raw diagnostics', (message, kind) => {
    expect(classifyCliMaintenanceError(message)).toEqual({ kind, detail: message });
  });

  it('shows an actionable summary while keeping raw stderr collapsed', () => {
    expect(cliTab).toContain('classifyCliMaintenanceError(details)');
    expect(cliTab).toContain('data-testid="cli-error-notice"');
    expect(cliTab).toContain('data-testid="cli-error-technical-details"');
    expect(cliTab).toContain('{error.detail}');
    expect(cliTab).toContain("t(`cli.error.${error.kind}.title`)");
    expect(cliTab).toContain("t(`cli.error.${error.kind}.action`)");
  });

  it('ships localized title/action pairs for every classified failure', () => {
    for (const kind of [
      'network',
      'blockedAutomation',
      'blockedSessions',
      'runtime',
      'permission',
      'owner',
      'unknown',
    ]) {
      expect(i18n.match(new RegExp(`'cli\\.error\\.${kind}\\.title'`, 'g'))).toHaveLength(2);
      expect(i18n.match(new RegExp(`'cli\\.error\\.${kind}\\.action'`, 'g'))).toHaveLength(2);
    }
    expect(i18n.match(/'cli\.error\.technicalDetails'/g)).toHaveLength(2);
  });
});

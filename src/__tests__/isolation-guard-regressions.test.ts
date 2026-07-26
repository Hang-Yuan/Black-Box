import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const helperUrl = pathToFileURL(
  resolve(import.meta.dirname, '../../scripts/isolation-guard.mjs'),
).href;

function runGuardScript(source: string, extraEnv: Record<string, string> = {}) {
  return execFileSync(
    process.execPath,
    ['--input-type=module', '-e', source],
    {
      env: { ...process.env, ...extraEnv },
      encoding: 'utf8',
    },
  );
}

describe('isolated smoke workspace guard', () => {
  it('deletes isolated conversations and scheduled definitions whenever the smoke wrapper exits', () => {
    const wrapper = readFileSync(
      resolve(import.meta.dirname, '../../scripts/run-isolated.sh'),
      'utf8',
    );

    expect(wrapper).toContain('cleanup_isolated_runtime_state');
    expect(wrapper).toContain('trap finalize_isolated_run EXIT');
    expect(wrapper).toContain('assert_isolated_conversations_removed');
    expect(wrapper).toContain("status=3");
    expect(wrapper).toContain('"$isolated_home/.claude/projects"');
    expect(wrapper).toContain('"$isolated_home/.claude/sessions"');
    expect(wrapper).toContain('"$isolated_home/.claude/session-env"');
    expect(wrapper).toContain('"$isolated_home/.claude/shell-snapshots"');
    expect(wrapper).toContain('"$isolated_home/.claude/tasks"');
    expect(wrapper).toContain('"$isolated_home/.claude/file-history"');
    expect(wrapper).toContain('"$isolated_home/.blackbox/session-rewind-backups"');
    expect(wrapper).toContain('"$isolated_automation/task-locations"');
    expect(wrapper).toContain('"$isolated_automation/automations"');
    expect(wrapper).toContain('"$isolated_automation/run-settings"');
    expect(wrapper).toContain("-name 'mcp-session-*.json' -delete");
    expect(wrapper).toContain('"$isolated_home/.blackbox/smoke-runs"');
    expect(wrapper).toContain("-name 'stream.jsonl' -delete");
    expect(wrapper).toContain('"$isolated_automation/automations.sqlite"');
    expect(wrapper).toContain('"$isolated_home/.blackbox/tracked_sessions.txt"');
    expect(wrapper).toContain('"$isolated_home/.blackbox/session_metadata.json"');
    expect(wrapper).toContain('"$isolated_home/.blackbox/archived.json"');
    expect(wrapper).toContain('"$isolated_home/.blackbox/groups.json"');
    expect(wrapper).toContain('"$isolated_home/.blackbox/forks.json"');
    expect(wrapper).toContain('"$isolated_home/.blackbox/goals.json"');
    expect(wrapper).toContain('"$isolated_home/.blackbox/plans.json"');
    expect(wrapper).toContain('"$isolated_home/.blackbox/review-comments.json"');
    expect(wrapper).toContain('"$isolated_home/.blackbox/workflow-runs.json"');
    expect(wrapper).toContain('"$isolated_home/Library/WebKit"');
    expect(wrapper).toContain('"$isolated_home/Library/Caches/blackbox/WebKit"');
    expect(wrapper).not.toContain('Library/WebKit/com.blackbox.app.dev');
    expect(wrapper).not.toContain('exec "$@"');
  });

  it('redirects the Dev bundle WebKit profile into the isolated home', () => {
    const wrapper = readFileSync(
      resolve(import.meta.dirname, '../../scripts/run-isolated.sh'),
      'utf8',
    );

    expect(wrapper).toContain('export CFFIXED_USER_HOME="$isolated_home"');
    expect(wrapper).toContain('"$isolated_home/Library/WebKit"');
  });

  it('gives every isolated smoke the same Claude binary and provider profile', () => {
    const wrapper = readFileSync(
      resolve(import.meta.dirname, '../../scripts/run-isolated.sh'),
      'utf8',
    );

    expect(wrapper).toContain('isolated_claude_bin="$isolated_home/.claude/local/claude"');
    expect(wrapper).toContain('export BLACKBOX_SMOKE_CLAUDE_BIN=');
    expect(wrapper).toContain('export BLACKBOX_SMOKE_PROVIDER_FILE=');
    expect(wrapper).toContain('$isolated_home/.blackbox/providers.json');
  });

  it('makes the host Node interpreter available without inheriting host HOME', () => {
    const wrapper = readFileSync(
      resolve(import.meta.dirname, '../../scripts/run-isolated.sh'),
      'utf8',
    );

    expect(wrapper).toContain('BLACKBOX_HOST_NODE_BIN');
    expect(wrapper).toContain('Configured host Node is not executable');
    expect(wrapper).toContain('export PATH="$(dirname "$host_node_bin"):$PATH"');
    expect(wrapper.indexOf('host_node_bin="${BLACKBOX_HOST_NODE_BIN:-}"')).toBeLessThan(
      wrapper.indexOf('export HOME="$isolated_home"'),
    );
  });

  it('routes every native smoke entrypoint through the cleanup wrapper', () => {
    const scriptsDir = resolve(import.meta.dirname, '../../scripts');
    const packageJson = JSON.parse(readFileSync(
      resolve(import.meta.dirname, '../../package.json'),
      'utf8',
    )) as { scripts?: Record<string, string> };
    const smokeFiles = readdirSync(scriptsDir)
      .filter((name) => name.endsWith('-smoke.mjs'))
      .sort();
    const smokeCommands = Object.entries(packageJson.scripts || {})
      .filter(([name]) => name.includes('smoke'))
      .map(([, command]) => command);

    expect(smokeFiles.length).toBeGreaterThan(0);
    for (const smokeFile of smokeFiles) {
      const entrypoint = `node scripts/${smokeFile}`;
      expect(
        smokeCommands.some((command) => (
          command.includes('scripts/run-isolated.sh') && command.includes(entrypoint)
        )),
        `${smokeFile} must have a package entrypoint guarded by run-isolated.sh`,
      ).toBe(true);
    }
  });

  it('rejects execution inside source or caller-declared private roots', () => {
    const output = runGuardScript(`
      import { assertExternalExecutionRoot, configuredPrivateRoots } from ${JSON.stringify(helperUrl)};
      const roots = configuredPrivateRoots('/tmp/blackbox-source');
      for (const candidate of ['/tmp/blackbox-source/work', '/tmp/blackbox-private/work']) {
        let rejected = false;
        try { assertExternalExecutionRoot(candidate, roots); } catch { rejected = true; }
        if (!rejected) throw new Error('unsafe root was accepted: ' + candidate);
      }
      assertExternalExecutionRoot('/tmp/blackbox-quarantine', roots);
      process.stdout.write(String(roots.length));
    `, { BLACKBOX_PRIVATE_ROOTS: '/tmp/blackbox-private' });

    expect(output).toBe('2');
  });

  it('rejects private paths found in model tool inputs while allowing ordinary text', () => {
    const output = runGuardScript(`
      import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { assertNoPrivateToolAccess } from ${JSON.stringify(helperUrl)};
      const root = mkdtempSync(join(tmpdir(), 'blackbox-isolation-'));
      const jsonl = join(root, 'session.jsonl');
      try {
        writeFileSync(jsonl, JSON.stringify({ type: 'assistant', message: { content: [
          { type: 'text', text: '/tmp/private-zone/mentioned as ordinary text' },
        ] } }) + '\\n');
        assertNoPrivateToolAccess(jsonl, ['/tmp/private-zone']);
        writeFileSync(jsonl, JSON.stringify({ type: 'assistant', message: { content: [
          { type: 'tool_use', input: { path: '/tmp/private-zone/secret.txt' } },
        ] } }) + '\\n');
        let rejected = false;
        try { assertNoPrivateToolAccess(jsonl, ['/tmp/private-zone']); } catch { rejected = true; }
        if (!rejected) throw new Error('private tool input was accepted');
        process.stdout.write('guarded');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    `);

    expect(output).toBe('guarded');
  });
});

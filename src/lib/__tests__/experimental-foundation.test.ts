import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  EXPERIMENTAL_FOUNDATION_PRODUCTION_INTEGRATION,
  executeExperimentalMemoryImport,
  getExperimentalFoundationStatus,
  initializeExperimentalMemoryStore,
  initializeExperimentalRuntimeFence,
  previewExperimentalMemoryImport,
  recordExperimentalNoEffectTurn,
} from '../experimental-foundation';

function productionSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...productionSourceFiles(absolute));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (absolute.endsWith(`${path.sep}experimental-foundation.ts`)) continue;
    files.push(absolute);
  }
  return files;
}

describe('experimental foundation bridge', () => {
  beforeEach(() => invokeMock.mockReset());

  it('is inert on import and declares that production reads are unchanged', () => {
    expect(invokeMock).not.toHaveBeenCalled();
    expect(EXPERIMENTAL_FOUNDATION_PRODUCTION_INTEGRATION).toBe(false);

    const srcRoot = path.resolve(process.cwd(), 'src');
    const integratedFiles = productionSourceFiles(srcRoot).filter((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return source.includes('experimental-foundation')
        || source.includes('record_experimental_no_effect_turn')
        || source.includes('execute_experimental_memory_import');
    });
    expect(integratedFiles).toEqual([]);
  });

  it('uses explicit commands and never performs hidden initialization', async () => {
    invokeMock.mockResolvedValue({ productionIntegration: false });

    await getExperimentalFoundationStatus();
    expect(invokeMock).toHaveBeenLastCalledWith('get_experimental_foundation_status');

    await initializeExperimentalRuntimeFence();
    expect(invokeMock).toHaveBeenLastCalledWith('initialize_experimental_runtime_fence');

    await initializeExperimentalMemoryStore();
    expect(invokeMock).toHaveBeenLastCalledWith('initialize_experimental_memory_store');
  });

  it('preserves strict input envelopes for runtime and Memory migration', async () => {
    invokeMock.mockResolvedValue({});
    const input = {
      commandId: 'cmd-1',
      sessionId: 'session-1',
      adapterId: 'no-effect-v1',
      generation: 1,
      configHash: 'config-v1',
      policySnapshotHash: 'policy-v1',
      text: 'hash this but do not dispatch it',
    };
    await recordExperimentalNoEffectTurn(input);
    expect(invokeMock).toHaveBeenLastCalledWith('record_experimental_no_effect_turn', { input });

    const request = {
      sourcePath: '/isolated/legacy.md',
      userId: 'test-user',
      workspaceId: 'test-workspace',
    };
    await previewExperimentalMemoryImport(request);
    expect(invokeMock).toHaveBeenLastCalledWith('preview_experimental_memory_import', { request });

    const confirmed = { ...request, expectedSourceSha256: 'abc123' };
    await executeExperimentalMemoryImport(confirmed);
    expect(invokeMock).toHaveBeenLastCalledWith('execute_experimental_memory_import', {
      request: confirmed,
    });
  });
});

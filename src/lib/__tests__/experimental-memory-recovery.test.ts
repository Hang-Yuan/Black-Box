import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  EXPERIMENTAL_MEMORY_RECOVERY_AUTOMATIC_RESTORE,
  EXPERIMENTAL_MEMORY_RECOVERY_DUAL_READ,
  EXPERIMENTAL_MEMORY_RECOVERY_PRODUCTION_INTEGRATION,
  getExperimentalMemoryRecoveryStatus,
  initializeExperimentalMemoryRecovery,
  inspectExperimentalMemoryRecoveryJournal,
  prepareExperimentalMemoryRecoveryDrill,
  reconcileExperimentalMemoryRecoveryDrill,
  recordExperimentalMemoryQuarantineContract,
} from '../experimental-memory-recovery';

function productionSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...productionSourceFiles(absolute));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (absolute.endsWith(`${path.sep}experimental-memory-recovery.ts`)) continue;
    files.push(absolute);
  }
  return files;
}

describe('experimental Memory recovery bridge', () => {
  beforeEach(() => invokeMock.mockReset());

  it('is inert and has no production Memory or UI call-site', () => {
    expect(invokeMock).not.toHaveBeenCalled();
    expect(EXPERIMENTAL_MEMORY_RECOVERY_PRODUCTION_INTEGRATION).toBe(false);
    expect(EXPERIMENTAL_MEMORY_RECOVERY_AUTOMATIC_RESTORE).toBe(false);
    expect(EXPERIMENTAL_MEMORY_RECOVERY_DUAL_READ).toBe(false);

    const integratedFiles = productionSourceFiles(path.resolve(process.cwd(), 'src')).filter(
      (file) => {
        const source = fs.readFileSync(file, 'utf8');
        return source.includes('experimental-memory-recovery')
          || source.includes('get_experimental_memory_recovery_status')
          || source.includes('initialize_experimental_memory_recovery')
          || source.includes('prepare_experimental_memory_recovery_drill')
          || source.includes('reconcile_experimental_memory_recovery_drill')
          || source.includes('record_experimental_memory_quarantine_contract')
          || source.includes('inspect_experimental_memory_recovery_journal');
      },
    );
    expect(integratedFiles).toEqual([]);
  });

  it('routes only the six explicit isolated recovery commands', async () => {
    invokeMock.mockResolvedValue({ productionIntegration: false });

    await getExperimentalMemoryRecoveryStatus();
    expect(invokeMock).toHaveBeenLastCalledWith('get_experimental_memory_recovery_status');

    await initializeExperimentalMemoryRecovery();
    expect(invokeMock).toHaveBeenLastCalledWith('initialize_experimental_memory_recovery');

    const prepare = {
      operationId: 'memory-drill-1',
      expectedMemorySha256: 'a'.repeat(64),
      idempotencyKey: 'memory-prepare-1',
    };
    await prepareExperimentalMemoryRecoveryDrill(prepare);
    expect(invokeMock).toHaveBeenLastCalledWith('prepare_experimental_memory_recovery_drill', {
      input: prepare,
    });

    const reconcile = {
      operationId: prepare.operationId,
      expectedPreparedRecordSha256: 'b'.repeat(64),
      idempotencyKey: 'memory-reconcile-1',
    };
    await reconcileExperimentalMemoryRecoveryDrill(reconcile);
    expect(invokeMock).toHaveBeenLastCalledWith('reconcile_experimental_memory_recovery_drill', {
      input: reconcile,
    });

    const incident = {
      operationId: 'memory-incident-1',
      expectedMemorySha256: 'c'.repeat(64),
      incidentReasonSha256: 'd'.repeat(64),
      idempotencyKey: 'memory-incident-key-1',
    };
    await recordExperimentalMemoryQuarantineContract(incident);
    expect(invokeMock).toHaveBeenLastCalledWith(
      'record_experimental_memory_quarantine_contract',
      { input: incident },
    );

    await inspectExperimentalMemoryRecoveryJournal();
    expect(invokeMock).toHaveBeenLastCalledWith('inspect_experimental_memory_recovery_journal');
  });
});

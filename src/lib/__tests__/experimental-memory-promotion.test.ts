import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
  EXPERIMENTAL_MEMORY_PROMOTION_AUTHORITY_SWITCH_APPLIED,
  EXPERIMENTAL_MEMORY_PROMOTION_DUAL_READ_ENABLED,
  EXPERIMENTAL_MEMORY_PROMOTION_PRODUCTION_INTEGRATION,
  EXPERIMENTAL_MEMORY_PROMOTION_RESTORE_PERFORMED,
  assessExperimentalMemoryDualRead,
  captureExperimentalMemoryRawForensicEvidence,
  getExperimentalMemoryPromotionStatus,
  initializeExperimentalMemoryPromotion,
  inspectExperimentalMemoryPromotionJournal,
  prepareExperimentalMemoryAuthoritySwitch,
  prepareExperimentalMemoryManualRestore,
} from '../experimental-memory-promotion';

function productionSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...productionSourceFiles(absolute));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (absolute.endsWith(`${path.sep}experimental-memory-promotion.ts`)) continue;
    files.push(absolute);
  }
  return files;
}

describe('experimental Memory promotion bridge', () => {
  beforeEach(() => invokeMock.mockReset());

  it('is inert and has no production or UI call-site', () => {
    expect(EXPERIMENTAL_MEMORY_PROMOTION_PRODUCTION_INTEGRATION).toBe(false);
    expect(EXPERIMENTAL_MEMORY_PROMOTION_DUAL_READ_ENABLED).toBe(false);
    expect(EXPERIMENTAL_MEMORY_PROMOTION_AUTHORITY_SWITCH_APPLIED).toBe(false);
    expect(EXPERIMENTAL_MEMORY_PROMOTION_RESTORE_PERFORMED).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();

    const integrated = productionSourceFiles(path.resolve(process.cwd(), 'src')).filter((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return source.includes('experimental-memory-promotion')
        || source.includes('get_experimental_memory_promotion_status')
        || source.includes('initialize_experimental_memory_promotion')
        || source.includes('assess_experimental_memory_dual_read')
        || source.includes('prepare_experimental_memory_authority_switch')
        || source.includes('capture_experimental_memory_raw_forensic_evidence')
        || source.includes('prepare_experimental_memory_manual_restore')
        || source.includes('inspect_experimental_memory_promotion_journal');
    });
    expect(integrated).toEqual([]);
  });

  it('routes only the seven explicit isolated commands', async () => {
    invokeMock.mockResolvedValue({ productionIntegration: false });
    await getExperimentalMemoryPromotionStatus();
    expect(invokeMock).toHaveBeenLastCalledWith('get_experimental_memory_promotion_status');
    await initializeExperimentalMemoryPromotion();
    expect(invokeMock).toHaveBeenLastCalledWith('initialize_experimental_memory_promotion');

    const dual = {
      operationId: 'dual-read-1', sourcePath: '/isolated/legacy.md', userId: 'user-1',
      workspaceId: 'workspace-1', expectedSourceSha256: 'a'.repeat(64),
      expectedMemorySha256: 'b'.repeat(64), idempotencyKey: 'dual-key-1',
    };
    await assessExperimentalMemoryDualRead(dual);
    expect(invokeMock).toHaveBeenLastCalledWith('assess_experimental_memory_dual_read', { input: dual });

    const authority = {
      operationId: 'authority-1', dualReadRecordSha256: 'c'.repeat(64),
      recoveryRecordSha256: 'd'.repeat(64), expectedMemorySha256: 'b'.repeat(64),
      idempotencyKey: 'authority-key-1',
    };
    await prepareExperimentalMemoryAuthoritySwitch(authority);
    expect(invokeMock).toHaveBeenLastCalledWith('prepare_experimental_memory_authority_switch', { input: authority });

    const forensic = {
      operationId: 'incident-1', expectedMemorySha256: 'e'.repeat(64),
      incidentReasonSha256: 'f'.repeat(64), idempotencyKey: 'incident-key-1',
    };
    await captureExperimentalMemoryRawForensicEvidence(forensic);
    expect(invokeMock).toHaveBeenLastCalledWith('capture_experimental_memory_raw_forensic_evidence', { input: forensic });

    const restore = {
      operationId: 'restore-1', forensicRecordSha256: '1'.repeat(64),
      recoveryRecordSha256: '3'.repeat(64),
      candidatePath: '/isolated/snapshot.sqlite', expectedCandidateSha256: '2'.repeat(64),
      idempotencyKey: 'restore-key-1',
    };
    await prepareExperimentalMemoryManualRestore(restore);
    expect(invokeMock).toHaveBeenLastCalledWith('prepare_experimental_memory_manual_restore', { input: restore });

    await inspectExperimentalMemoryPromotionJournal();
    expect(invokeMock).toHaveBeenLastCalledWith('inspect_experimental_memory_promotion_journal');
  });
});

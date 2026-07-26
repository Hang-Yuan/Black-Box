import { invoke } from '@tauri-apps/api/core';

/**
 * Inert bridge for the disabled R3AU Memory recovery control plane.
 *
 * It can only address an explicitly isolated experimental profile. The Rust
 * boundary never changes the active Memory authority and never performs an
 * automatic restore, production migration, dual-read, or production write.
 */
export const EXPERIMENTAL_MEMORY_RECOVERY_PRODUCTION_INTEGRATION = false as const;
export const EXPERIMENTAL_MEMORY_RECOVERY_AUTOMATIC_RESTORE = false as const;
export const EXPERIMENTAL_MEMORY_RECOVERY_DUAL_READ = false as const;

export interface ExperimentalMemoryRecoveryStatus {
  enabled: boolean;
  platformSupported: boolean;
  initialized: boolean;
  ready: boolean;
  path: string;
  schemaVersion: number | null;
  schemaSha256: string;
  journalRecordCount: number;
  pendingRecoveryCount: number;
  hostWideLeaseEnforced: boolean;
  journalHmacVerified: boolean;
  immutableSnapshotsEnabled: boolean;
  automaticRestoreEnabled: false;
  dualReadEnabled: false;
  productionMemoryMutated: false;
  productionIntegration: false;
  blockedReason: string | null;
}

export interface PrepareMemoryRecoveryDrillInput {
  operationId: string;
  expectedMemorySha256: string;
  idempotencyKey: string;
}

export interface ReconcileMemoryRecoveryDrillInput {
  operationId: string;
  expectedPreparedRecordSha256: string;
  idempotencyKey: string;
}

export interface RecordMemoryQuarantineContractInput {
  operationId: string;
  expectedMemorySha256: string;
  incidentReasonSha256: string;
  idempotencyKey: string;
}

export interface MemoryRecoveryReceipt {
  operationId: string;
  operationKind: 'crash_recovery_drill' | 'quarantine_required';
  phase: 'prepared' | 'recovered_no_effect' | 'quarantine_required';
  recordSequence: number;
  recordSha256: string;
  recordHmacSha256: string;
  memoryDatabaseSha256: string;
  snapshotRelativePath: string;
  snapshotSha256: string;
  rollbackSnapshotBound: true;
  operatorActionRequired: boolean;
  quarantinePerformed: false;
  automaticRestoreEnabled: false;
  productionMemoryMutated: false;
  externalEffects: 0;
  duplicate: boolean;
  productionIntegration: false;
}

export interface MemoryRecoveryJournalInspection {
  schemaVersion: 1;
  journalRecordCount: number;
  pendingRecoveryCount: number;
  lastRecordSha256: string;
  hmacVerified: true;
  chainVerified: true;
  externalEffects: 0;
  productionMemoryMutated: false;
  productionIntegration: false;
}

export function getExperimentalMemoryRecoveryStatus(): Promise<ExperimentalMemoryRecoveryStatus> {
  return invoke<ExperimentalMemoryRecoveryStatus>('get_experimental_memory_recovery_status');
}

export function initializeExperimentalMemoryRecovery(): Promise<ExperimentalMemoryRecoveryStatus> {
  return invoke<ExperimentalMemoryRecoveryStatus>('initialize_experimental_memory_recovery');
}

export function prepareExperimentalMemoryRecoveryDrill(
  input: PrepareMemoryRecoveryDrillInput,
): Promise<MemoryRecoveryReceipt> {
  return invoke<MemoryRecoveryReceipt>('prepare_experimental_memory_recovery_drill', { input });
}

export function reconcileExperimentalMemoryRecoveryDrill(
  input: ReconcileMemoryRecoveryDrillInput,
): Promise<MemoryRecoveryReceipt> {
  return invoke<MemoryRecoveryReceipt>('reconcile_experimental_memory_recovery_drill', { input });
}

export function recordExperimentalMemoryQuarantineContract(
  input: RecordMemoryQuarantineContractInput,
): Promise<MemoryRecoveryReceipt> {
  return invoke<MemoryRecoveryReceipt>('record_experimental_memory_quarantine_contract', { input });
}

export function inspectExperimentalMemoryRecoveryJournal(): Promise<MemoryRecoveryJournalInspection> {
  return invoke<MemoryRecoveryJournalInspection>('inspect_experimental_memory_recovery_journal');
}

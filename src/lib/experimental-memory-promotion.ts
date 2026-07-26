import { invoke } from '@tauri-apps/api/core';

/** Inert bridge for the disabled R3AV Memory promotion control plane. */
export const EXPERIMENTAL_MEMORY_PROMOTION_PRODUCTION_INTEGRATION = false as const;
export const EXPERIMENTAL_MEMORY_PROMOTION_DUAL_READ_ENABLED = false as const;
export const EXPERIMENTAL_MEMORY_PROMOTION_AUTHORITY_SWITCH_APPLIED = false as const;
export const EXPERIMENTAL_MEMORY_PROMOTION_RESTORE_PERFORMED = false as const;

export interface ExperimentalMemoryPromotionStatus {
  enabled: boolean;
  platformSupported: boolean;
  initialized: boolean;
  ready: boolean;
  path: string;
  schemaVersion: number | null;
  schemaSha256: string;
  journalRecordCount: number;
  parityConfirmedCount: number;
  operatorProposalCount: number;
  journalHmacVerified: boolean;
  rawForensicCaptureEnabled: boolean;
  dualReadEnabled: false;
  authoritySwitchApplied: false;
  restorePerformed: false;
  productionMemoryMutated: false;
  productionIntegration: false;
  blockedReason: string | null;
}

export interface AssessMemoryDualReadInput {
  operationId: string;
  sourcePath: string;
  userId: string;
  workspaceId?: string | null;
  expectedSourceSha256: string;
  expectedMemorySha256: string;
  idempotencyKey: string;
}

export interface PrepareMemoryAuthoritySwitchInput {
  operationId: string;
  dualReadRecordSha256: string;
  recoveryRecordSha256: string;
  expectedMemorySha256: string;
  idempotencyKey: string;
}

export interface CaptureRawForensicEvidenceInput {
  operationId: string;
  expectedMemorySha256: string;
  incidentReasonSha256: string;
  idempotencyKey: string;
}

export interface PrepareManualRestoreProposalInput {
  operationId: string;
  forensicRecordSha256: string;
  recoveryRecordSha256: string;
  candidatePath: string;
  expectedCandidateSha256: string;
  idempotencyKey: string;
}

export interface MemoryPromotionReceipt {
  operationId: string;
  operationKind:
    | 'dual_read_assessment'
    | 'authority_switch_proposal'
    | 'raw_forensic_evidence'
    | 'manual_restore_proposal';
  phase: 'parity_confirmed' | 'parity_failed' | 'awaiting_operator' | 'raw_evidence_sealed';
  recordSequence: number;
  recordSha256: string;
  recordHmacSha256: string;
  sourceAuthoritySha256: string | null;
  memoryDatabaseSha256: string;
  evidenceRelativePath: string | null;
  evidenceSha256: string | null;
  comparedEntryCount: number;
  mismatchCount: number;
  promotionEligible: boolean;
  operatorActionRequired: boolean;
  rawForensicEvidenceSealed: boolean;
  dualReadEnabled: false;
  authoritySwitchApplied: false;
  restorePerformed: false;
  productionMemoryMutated: false;
  externalEffects: 0;
  duplicate: boolean;
  productionIntegration: false;
}

export interface MemoryPromotionJournalInspection {
  schemaVersion: 1;
  journalRecordCount: number;
  parityConfirmedCount: number;
  parityFailedCount: number;
  operatorProposalCount: number;
  rawForensicEvidenceCount: number;
  lastRecordSha256: string;
  hmacVerified: true;
  chainVerified: true;
  externalEffects: 0;
  dualReadEnabled: false;
  authoritySwitchApplied: false;
  restorePerformed: false;
  productionMemoryMutated: false;
  productionIntegration: false;
}

export function getExperimentalMemoryPromotionStatus(): Promise<ExperimentalMemoryPromotionStatus> {
  return invoke<ExperimentalMemoryPromotionStatus>('get_experimental_memory_promotion_status');
}

export function initializeExperimentalMemoryPromotion(): Promise<ExperimentalMemoryPromotionStatus> {
  return invoke<ExperimentalMemoryPromotionStatus>('initialize_experimental_memory_promotion');
}

export function assessExperimentalMemoryDualRead(
  input: AssessMemoryDualReadInput,
): Promise<MemoryPromotionReceipt> {
  return invoke<MemoryPromotionReceipt>('assess_experimental_memory_dual_read', { input });
}

export function prepareExperimentalMemoryAuthoritySwitch(
  input: PrepareMemoryAuthoritySwitchInput,
): Promise<MemoryPromotionReceipt> {
  return invoke<MemoryPromotionReceipt>('prepare_experimental_memory_authority_switch', { input });
}

export function captureExperimentalMemoryRawForensicEvidence(
  input: CaptureRawForensicEvidenceInput,
): Promise<MemoryPromotionReceipt> {
  return invoke<MemoryPromotionReceipt>('capture_experimental_memory_raw_forensic_evidence', { input });
}

export function prepareExperimentalMemoryManualRestore(
  input: PrepareManualRestoreProposalInput,
): Promise<MemoryPromotionReceipt> {
  return invoke<MemoryPromotionReceipt>('prepare_experimental_memory_manual_restore', { input });
}

export function inspectExperimentalMemoryPromotionJournal(): Promise<MemoryPromotionJournalInspection> {
  return invoke<MemoryPromotionJournalInspection>('inspect_experimental_memory_promotion_journal');
}

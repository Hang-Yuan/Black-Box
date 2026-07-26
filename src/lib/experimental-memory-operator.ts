import { invoke } from '@tauri-apps/api/core';

/** Inert bridge for the disabled-by-default R3AY isolated Memory rehearsal. */
export const EXPERIMENTAL_MEMORY_OPERATOR_EXECUTION_ADAPTER_AVAILABLE = true as const;
export const EXPERIMENTAL_MEMORY_OPERATOR_EXECUTION_DISPATCHED = false as const;
export const EXPERIMENTAL_MEMORY_OPERATOR_ISOLATED_REHEARSAL_ONLY = true as const;
export const EXPERIMENTAL_MEMORY_OPERATOR_PRODUCTION_INTEGRATION = false as const;

export type MemoryProposalKind = 'authority_switch_proposal' | 'manual_restore_proposal';
export type MemoryOperatorDecision = 'approve' | 'reject';
export type MemoryReviewerActionKind = 'proposal_review' | 'authorization_revocation';

export interface ExperimentalMemoryOperatorStatus {
  enabled: boolean;
  platformSupported: boolean;
  initialized: boolean;
  ready: boolean;
  path: string;
  schemaVersion: number | null;
  schemaSha256: string;
  exactSchemaDdlSha256: string;
  exactSchemaDdlVerified: boolean;
  journalRecordCount: number;
  approvedReviewCount: number;
  rejectedReviewCount: number;
  activeAuthorizationCount: number;
  consumedAuthorizationCount: number;
  revokedAuthorizationCount: number;
  journalHmacVerified: boolean;
  singleUseEnforced: boolean;
  preconsumptionValidationFailurePreservesAuthorization: boolean;
  postCommitRecoverySupported: true;
  executionAdapterAvailable: boolean;
  isolatedRehearsalOnly: true;
  executionDispatched: boolean;
  rollbackPerformed: boolean;
  productionMemoryMutated: false;
  productionIntegration: false;
  blockedReason: string | null;
}

export interface ReviewMemoryProposalInput {
  operationId: string;
  proposalRecordSha256: string;
  decision: MemoryOperatorDecision;
  reviewerSessionToken: string;
  reviewReasonSha256: string;
  idempotencyKey: string;
}

export interface CreateMemoryReviewerSessionInput {
  actionKind: MemoryReviewerActionKind;
  operationId: string;
  idempotencyKey: string;
  proposalRecordSha256: string;
  decision: MemoryOperatorDecision | null;
  authorizationRecordSha256: string | null;
  reasonSha256: string;
}

export interface MemoryReviewerSessionReceipt {
  actionKind: MemoryReviewerActionKind;
  reviewerSubjectSha256: string;
  reviewerSessionToken: string;
  issuedAtMs: number;
  expiresAtMs: number;
  localAuthenticationVerified: true;
  productionIntegration: false;
}

export interface IssueMemoryExecutionAuthorizationInput {
  operationId: string;
  reviewRecordSha256: string;
  proposalRecordSha256: string;
  expectedMemorySha256: string;
  ttlSeconds: number;
  idempotencyKey: string;
}

export interface RevokeMemoryExecutionAuthorizationInput {
  operationId: string;
  authorizationRecordSha256: string;
  proposalRecordSha256: string;
  reviewerSessionToken: string;
  revocationReasonSha256: string;
  idempotencyKey: string;
}

export interface ConsumeMemoryExecutionAuthorizationInput {
  operationId: string;
  authorizationRecordSha256: string;
  proposalRecordSha256: string;
  expectedMemorySha256: string;
  authorizationToken: string;
  idempotencyKey: string;
}

export interface MemoryOperatorReceipt {
  operationId: string;
  operationKind:
    | 'operator_review'
    | 'execution_authorization'
    | 'authorization_revocation'
    | 'authorization_consumption';
  phase:
    | 'approved'
    | 'rejected'
    | 'issued'
    | 'revoked'
    | 'consumed_no_effect'
    | 'consumed_rehearsal_applied'
    | 'consumed_rehearsal_restored';
  recordSequence: number;
  recordSha256: string;
  recordHmacSha256: string;
  proposalRecordSha256: string;
  proposalKind: MemoryProposalKind;
  reviewRecordSha256: string | null;
  decision: MemoryOperatorDecision | null;
  reviewerSubjectSha256: string;
  authorizationId: string | null;
  /** Returned exactly once on initial issuance; never replayed by an idempotent retry. */
  authorizationToken: string | null;
  authorizationRecordSha256: string | null;
  /** Present only for isolated-rehearsal capabilities and binds them to one authority generation. */
  rehearsalAuthorityStateSha256: string | null;
  issuedAtMs: number | null;
  expiresAtMs: number | null;
  promotionSchemaDdlSha256: string;
  recoverySchemaDdlSha256: string;
  memoryDatabaseSha256: string;
  authorizationConsumed: boolean;
  executionDispatched: boolean;
  rollbackPerformed: boolean;
  productionMemoryMutated: false;
  externalEffects: 0;
  duplicate: boolean;
  productionIntegration: false;
}

export interface MemoryOperatorJournalInspection {
  schemaVersion: 1;
  exactSchemaDdlSha256: string;
  journalRecordCount: number;
  approvedReviewCount: number;
  rejectedReviewCount: number;
  issuedAuthorizationCount: number;
  activeAuthorizationCount: number;
  consumedAuthorizationCount: number;
  revokedAuthorizationCount: number;
  lastRecordSha256: string;
  hmacVerified: true;
  chainVerified: true;
  exactSchemaDdlVerified: true;
  singleUseEnforced: true;
  preconsumptionValidationFailurePreservesAuthorization: true;
  postCommitRecoverySupported: true;
  executionAdapterAvailable: true;
  isolatedRehearsalOnly: true;
  executionDispatched: boolean;
  rollbackPerformed: boolean;
  productionMemoryMutated: false;
  externalEffects: 0;
  productionIntegration: false;
}

export interface MemoryRehearsalAuthorityState {
  generation: number;
  authorityKind: 'legacy_snapshot' | 'sqlite_memory_v3';
  authorityBindingSha256: string;
  previousAuthorityKind: 'legacy_snapshot' | 'sqlite_memory_v3' | null;
  previousAuthorityBindingSha256: string | null;
  lastAuthorizationRecordSha256: string | null;
  lastExecutionRecordSha256: string | null;
  productionIntegration: false;
  updatedAtMs: number;
}

export function getExperimentalMemoryOperatorStatus(): Promise<ExperimentalMemoryOperatorStatus> {
  return invoke<ExperimentalMemoryOperatorStatus>('get_experimental_memory_operator_status');
}

export function initializeExperimentalMemoryOperator(): Promise<ExperimentalMemoryOperatorStatus> {
  return invoke<ExperimentalMemoryOperatorStatus>('initialize_experimental_memory_operator');
}

export function createExperimentalMemoryReviewerSession(
  input: CreateMemoryReviewerSessionInput,
): Promise<MemoryReviewerSessionReceipt> {
  return invoke<MemoryReviewerSessionReceipt>(
    'create_experimental_memory_reviewer_session',
    { input },
  );
}

export function reviewExperimentalMemoryProposal(
  input: ReviewMemoryProposalInput,
): Promise<MemoryOperatorReceipt> {
  return invoke<MemoryOperatorReceipt>('review_experimental_memory_proposal', { input });
}

export function issueExperimentalMemoryExecutionAuthorization(
  input: IssueMemoryExecutionAuthorizationInput,
): Promise<MemoryOperatorReceipt> {
  return invoke<MemoryOperatorReceipt>('issue_experimental_memory_execution_authorization', { input });
}

export function issueExperimentalMemoryRehearsalAuthorization(
  input: IssueMemoryExecutionAuthorizationInput,
): Promise<MemoryOperatorReceipt> {
  return invoke<MemoryOperatorReceipt>('issue_experimental_memory_rehearsal_authorization', { input });
}

export function revokeExperimentalMemoryExecutionAuthorization(
  input: RevokeMemoryExecutionAuthorizationInput,
): Promise<MemoryOperatorReceipt> {
  return invoke<MemoryOperatorReceipt>('revoke_experimental_memory_execution_authorization', { input });
}

export function consumeExperimentalMemoryExecutionAuthorizationNoEffect(
  input: ConsumeMemoryExecutionAuthorizationInput,
): Promise<MemoryOperatorReceipt> {
  return invoke<MemoryOperatorReceipt>(
    'consume_experimental_memory_execution_authorization_no_effect',
    { input },
  );
}

export function executeExperimentalMemoryAuthorityRehearsal(
  input: ConsumeMemoryExecutionAuthorizationInput,
): Promise<MemoryOperatorReceipt> {
  return invoke<MemoryOperatorReceipt>('execute_experimental_memory_authority_rehearsal', { input });
}

export function inspectExperimentalMemoryOperatorJournal(): Promise<MemoryOperatorJournalInspection> {
  return invoke<MemoryOperatorJournalInspection>('inspect_experimental_memory_operator_journal');
}

export function inspectExperimentalMemoryRehearsalAuthority(): Promise<MemoryRehearsalAuthorityState> {
  return invoke<MemoryRehearsalAuthorityState>('inspect_experimental_memory_rehearsal_authority');
}

import { invoke } from '@tauri-apps/api/core';

/**
 * Inert bridge for the disabled RAG consent/proposal foundation.
 *
 * Importing this file does not initialize a store, watch a path, parse a file,
 * index content, retrieve knowledge or apply an organization proposal.
 */
export const EXPERIMENTAL_RAG_PRODUCTION_INTEGRATION = false as const;

export interface ExperimentalRagStatus {
  enabled: boolean;
  initialized: boolean;
  ready: boolean;
  path: string;
  schemaVersion: number | null;
  schemaSha256: string;
  productionIntegration: false;
  currentKnowledgeAuthority: 'existing-files-and-explicit-user-context';
  ingestEnabled: false;
  retrievalEnabled: false;
  autoOrganizationEnabled: false;
  blockedReason: string | null;
}

export interface RegisterRagSourceInput {
  sourceId: string;
  tenantId: string;
  ownerUserId: string;
  sourceKind: 'directory' | 'file';
  rootPath: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  idempotencyKey: string;
}

export interface RagSourceReceipt {
  sourceId: string;
  tenantId: string;
  ownerUserId: string;
  sourceKind: 'directory' | 'file';
  rootPath: string;
  sourceBindingRevision: string;
  consentState: 'pending' | 'granted_local_only' | 'revoked';
  authorizationGeneration: number;
  policyRevision: string;
  enabled: boolean;
  receiptSha256: string;
  duplicate: boolean;
  ingestEnabled: false;
  retrievalEnabled: false;
}

export interface ChangeRagConsentInput {
  sourceId: string;
  tenantId: string;
  ownerUserId: string;
  expectedGeneration: number;
  nextState: 'grantedLocalOnly' | 'revoked';
  includeGlobs?: string[] | null;
  excludeGlobs?: string[] | null;
  requestId: string;
}

export interface RagConsentReceipt {
  sourceId: string;
  fromState: 'pending' | 'granted_local_only' | 'revoked';
  toState: 'grantedLocalOnly' | 'revoked';
  authorizationGeneration: number;
  policyRevision: string;
  cancelledProposalCount: number;
  receiptSha256: string;
  duplicate: boolean;
  logicalPayloadsPurged: true;
  forensicErasureGuaranteed: false;
  ingestEnabled: false;
  retrievalEnabled: false;
}

export interface CreateRagProposalInput {
  proposalId: string;
  tenantId: string;
  ownerUserId: string;
  sourceId: string;
  expectedGeneration: number;
  expectedPolicyRevision: string;
  proposalKind: 'tag' | 'cluster' | 'link' | 'title';
  target: Record<string, unknown>;
  evidenceSha256: string[];
  modelId: string;
  promptVersion: string;
  confidence: number;
  idempotencyKey: string;
}

export interface RagProposalReceipt {
  proposalId: string;
  sourceId: string;
  authorizationGeneration: number;
  policyRevision: string;
  sourceBindingRevision: string;
  status: 'pending';
  autoApply: false;
  receiptSha256: string;
  duplicate: boolean;
  externalEffects: 0;
  ingestPerformed: false;
}

export interface ReviewRagProposalInput {
  proposalId: string;
  tenantId: string;
  ownerUserId: string;
  action: 'approve' | 'reject' | 'revert';
  reason: string;
  idempotencyKey: string;
}

export interface RagProposalReviewReceipt {
  proposalId: string;
  action: 'approve' | 'reject' | 'revert';
  status: 'approved' | 'rejected' | 'reverted';
  receiptSha256: string;
  duplicate: boolean;
  autoApplied: false;
  externalEffects: 0;
}

export function getExperimentalRagConsentStatus(): Promise<ExperimentalRagStatus> {
  return invoke<ExperimentalRagStatus>('get_experimental_rag_consent_status');
}

export function initializeExperimentalRagConsentStore(): Promise<ExperimentalRagStatus> {
  return invoke<ExperimentalRagStatus>('initialize_experimental_rag_consent_store');
}

export function registerExperimentalRagSource(
  input: RegisterRagSourceInput,
): Promise<RagSourceReceipt> {
  return invoke<RagSourceReceipt>('register_experimental_rag_source', { input });
}

export function changeExperimentalRagSourceConsent(
  input: ChangeRagConsentInput,
): Promise<RagConsentReceipt> {
  return invoke<RagConsentReceipt>('change_experimental_rag_source_consent', { input });
}

export function createExperimentalRagOrganizationProposal(
  input: CreateRagProposalInput,
): Promise<RagProposalReceipt> {
  return invoke<RagProposalReceipt>('create_experimental_rag_organization_proposal', { input });
}

export function reviewExperimentalRagOrganizationProposal(
  input: ReviewRagProposalInput,
): Promise<RagProposalReviewReceipt> {
  return invoke<RagProposalReviewReceipt>('review_experimental_rag_organization_proposal', { input });
}

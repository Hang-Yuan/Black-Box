import { invoke } from '@tauri-apps/api/core';

/**
 * Inert bridge for the disabled managed-provider v1 contract boundary.
 *
 * Importing this module never reads a credential, calls a Provider, mutates a
 * balance, initiates payment or changes the active Black Box routing path.
 */
export const EXPERIMENTAL_MANAGED_PROVIDER_PRODUCTION_INTEGRATION = false as const;
export const EXPERIMENTAL_MANAGED_PROVIDER_REAL_MONEY = false as const;
export const EXPERIMENTAL_MANAGED_PROVIDER_DISPATCH = false as const;

export type ManagedProviderId =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'deepseek'
  | 'glm'
  | 'doubao'
  | 'qwen'
  | 'minimax'
  | 'kimi';

export type ManagedProviderTier = 'frontier' | 'high' | 'balanced' | 'fast';
export type ManagedProviderSupplyMode = 'managed' | 'channel';
export type ManagedProviderExecutionClass =
  | 'conversation'
  | 'subagent'
  | 'webSearch'
  | 'webFetch';

export interface ExperimentalManagedProviderStatus {
  enabled: boolean;
  initialized: boolean;
  ready: boolean;
  path: string;
  schemaVersion: number | null;
  schemaSha256: string;
  /** Canonical sqlite_master manifest hash, including CHECKs and trigger bodies. */
  exactSchemaDdlSha256: string;
  exactSchemaDdlVerified: boolean;
  productionIntegration: false;
  providerDispatchEnabled: false;
  realMoneyCollectionEnabled: false;
  balanceMutationEnabled: false;
  hostedCredentialAccessEnabled: false;
  rendererCredentialAccessEnabled: false;
  requiredProviders: ManagedProviderId[];
  logicalTierSlots: ManagedProviderTier[];
  auxiliaryExecutionClasses: Array<'subagent' | 'web_search' | 'web_fetch'>;
  moneyKillSwitchScopes: Array<'global' | 'provider' | 'tenant'>;
  blockedReason: string | null;
}

export interface RegisterProviderContractInput {
  recordId: string;
  revision: number;
  contractStatus: 'evidencePending' | 'syntheticValidated';
  providerId: ManagedProviderId;
  providerSku: string;
  modelFamilyId: string;
  logicalTier: ManagedProviderTier;
  supplyMode: ManagedProviderSupplyMode;
  servingRegion: string;
  inferenceRegion: string;
  storageRegion: string;
  billingRegion: string;
  pricingSnapshotId: string;
  currency: string;
  /** SHA-256 of an opaque secret-manager reference; never the reference or key. */
  credentialReferenceSha256: string;
  /** Synthetic contract-test evidence only; it has no provider authority. */
  evidenceBundleSha256?: string;
  idempotencyKey: string;
}

export interface ProviderContractReceipt {
  recordId: string;
  revision: number;
  contractStatus: RegisterProviderContractInput['contractStatus'];
  providerId: ManagedProviderId;
  providerSku: string;
  modelFamilyId: string;
  logicalTier: ManagedProviderTier;
  supplyMode: ManagedProviderSupplyMode;
  productFlow: 'server_side_managed_application' | 'authorized_channel_service';
  credentialRouteClass: 'hosted_blackbox_managed' | 'hosted_authorized_channel';
  scopeSha256: string;
  onboardingDecisionSha256: string;
  providerAuthorizationEffective: false;
  routingEligible: false;
  dispatchEnabled: false;
  realMoneyCollectionEnabled: false;
  rendererCredentialAccessEnabled: false;
  duplicate: boolean;
  productionIntegration: false;
}

export interface CreateManagedRouteContractInput {
  tenantId: string;
  organizationId: string;
  requestId: string;
  attemptId: string;
  executionClass: ManagedProviderExecutionClass;
  requestedTier: ManagedProviderTier;
  modelId: string;
  auxiliaryEligible: boolean;
  allowPrimaryFallback: boolean;
  onboardingRecordId: string;
  onboardingRevision: number;
  expectedOnboardingDecisionSha256: string;
  maximumCostMicros: number;
  idempotencyKey: string;
}

export interface ManagedRouteContractReceipt {
  tenantId: string;
  organizationId: string;
  requestId: string;
  attemptId: string;
  executionClass: ManagedProviderExecutionClass;
  requestedTier: ManagedProviderTier;
  providerId: ManagedProviderId;
  modelId: string;
  supplyMode: ManagedProviderSupplyMode;
  onboardingDecisionSha256: string;
  bindingSha256: string;
  ledgerIntentId: string;
  routeState: 'prepared_no_effect' | 'reconciliation_pending';
  auxiliaryRouteForced: boolean;
  primaryFallbackEnabled: false;
  globalRealMoneyEnabled: false;
  providerRealMoneyEnabled: false;
  tenantRealMoneyEnabled: false;
  dispatchEnabled: false;
  credentialAccessEnabled: false;
  balanceMutationEnabled: false;
  externalEffects: 0;
  duplicate: boolean;
  productionIntegration: false;
}

export interface RecordUnknownOutcomeInput {
  tenantId: string;
  organizationId: string;
  requestId: string;
  attemptId: string;
  expectedBindingSha256: string;
  reasonSha256: string;
  providerRequestReferenceSha256?: string;
  contractSimulation: true;
  idempotencyKey: string;
}

export interface UnknownOutcomeReceipt {
  reconciliationCaseId: string;
  tenantId: string;
  organizationId: string;
  requestId: string;
  attemptId: string;
  bindingSha256: string;
  caseStatus: 'pending';
  automaticSettlementEnabled: false;
  realMoneyCollectionEnabled: false;
  externalEffects: 0;
  duplicate: boolean;
  productionIntegration: false;
}

export function getExperimentalManagedProviderStatus(): Promise<ExperimentalManagedProviderStatus> {
  return invoke<ExperimentalManagedProviderStatus>('get_experimental_managed_provider_status');
}

export function initializeExperimentalManagedProviderStore(): Promise<ExperimentalManagedProviderStatus> {
  return invoke<ExperimentalManagedProviderStatus>('initialize_experimental_managed_provider_store');
}

export function registerExperimentalProviderContract(
  input: RegisterProviderContractInput,
): Promise<ProviderContractReceipt> {
  return invoke<ProviderContractReceipt>('register_experimental_provider_contract', { input });
}

export function createExperimentalManagedRouteContract(
  input: CreateManagedRouteContractInput,
): Promise<ManagedRouteContractReceipt> {
  return invoke<ManagedRouteContractReceipt>('create_experimental_managed_route_contract', { input });
}

export function recordExperimentalManagedUnknownOutcome(
  input: RecordUnknownOutcomeInput,
): Promise<UnknownOutcomeReceipt> {
  return invoke<UnknownOutcomeReceipt>('record_experimental_managed_unknown_outcome', { input });
}

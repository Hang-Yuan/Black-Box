import { invoke } from '@tauri-apps/api/core';

/**
 * Provider-neutral foundations staged for the next Black Box runtime.
 *
 * Importing this module never initializes a database or changes the current
 * chat/memory read path. Every mutating Rust command is independently guarded
 * by a disabled-by-default environment feature flag.
 */
export const EXPERIMENTAL_FOUNDATION_PRODUCTION_INTEGRATION = false as const;

export interface FoundationComponentStatus {
  enabled: boolean;
  initialized: boolean;
  ready: boolean;
  path: string;
  schemaVersion: number | null;
  schemaSha256: string;
  blockedReason: string | null;
}

export interface ExperimentalFoundationStatus {
  schemaVersion: number;
  productionIntegration: false;
  currentRuntimeAuthority: 'claude-sdk-session-path';
  currentMemoryAuthority: 'existing-markdown-and-session-context';
  runtime: FoundationComponentStatus;
  memory: FoundationComponentStatus;
}

export interface NoEffectTurnInput {
  commandId: string;
  sessionId: string;
  adapterId: string;
  generation: number;
  configHash: string;
  policySnapshotHash: string;
  text: string;
}

export interface NoEffectTurnReceipt {
  commandId: string;
  sessionId: string;
  generation: number;
  phase: 'completed';
  journalSequence: number;
  canonicalPayloadSha256: string;
  adapterReceiptSha256: string;
  duplicate: boolean;
  externalEffects: 0;
}

export interface MemoryImportRequest {
  sourcePath: string;
  userId: string;
  workspaceId?: string | null;
  expectedSourceSha256?: string | null;
}

export interface MemoryImportPreview {
  sourcePath: string;
  sourceSha256: string;
  sourceBytes: number;
  sourceDevice: string;
  sourceInode: string;
  eventCount: number;
  itemCount: number;
  confirmationRequired: boolean;
}

export interface MemoryImportReceipt {
  importId: string;
  sourceSha256: string;
  backupSha256: string;
  backupPath: string;
  importedEventCount: number;
  importedItemCount: number;
  parityVerified: boolean;
  duplicate: boolean;
  currentReadsSwitched: false;
}

export function getExperimentalFoundationStatus(): Promise<ExperimentalFoundationStatus> {
  return invoke<ExperimentalFoundationStatus>('get_experimental_foundation_status');
}

export function initializeExperimentalRuntimeFence(): Promise<ExperimentalFoundationStatus> {
  return invoke<ExperimentalFoundationStatus>('initialize_experimental_runtime_fence');
}

export function initializeExperimentalMemoryStore(): Promise<ExperimentalFoundationStatus> {
  return invoke<ExperimentalFoundationStatus>('initialize_experimental_memory_store');
}

export function recordExperimentalNoEffectTurn(
  input: NoEffectTurnInput,
): Promise<NoEffectTurnReceipt> {
  return invoke<NoEffectTurnReceipt>('record_experimental_no_effect_turn', { input });
}

export function previewExperimentalMemoryImport(
  request: MemoryImportRequest,
): Promise<MemoryImportPreview> {
  return invoke<MemoryImportPreview>('preview_experimental_memory_import', { request });
}

export function executeExperimentalMemoryImport(
  request: MemoryImportRequest,
): Promise<MemoryImportReceipt> {
  return invoke<MemoryImportReceipt>('execute_experimental_memory_import', { request });
}

import { invoke } from '@tauri-apps/api/core';

/**
 * Inert bridge for the disabled PetPack v1 validation boundary.
 *
 * Importing this module never discovers, activates, renders or persists a pack.
 * The code-native desktop companion remains the only production authority.
 */
export const EXPERIMENTAL_PETPACK_PRODUCTION_INTEGRATION = false as const;

export type PetPackState =
  | 'idle'
  | 'thinking'
  | 'tool'
  | 'running'
  | 'waiting'
  | 'error';

export interface ExperimentalPetPackStatus {
  enabled: boolean;
  productionIntegration: false;
  validationAvailable: boolean;
  activationEnabled: false;
  creatorExportEnabled: false;
  schemaVersion: number;
  schemaSha256: string;
  requiredStates: PetPackState[];
  performanceMeasurementRequired: true;
  rightsApprovalRequired: true;
}

export interface ValidatePetPackInput {
  packRoot: string;
}

export interface PetPackValidationReport {
  valid: true;
  packId: string;
  version: string;
  status: string;
  species: string;
  schemaVersion: number;
  schemaSha256: string;
  manifestSha256: string;
  assetRootSha256: string;
  requiredStatesValidated: number;
  uniquePrimaryAssets: number;
  reducedMotionAssets: number;
  totalUniqueAssetBytes: number;
  alphaAssetsValidated: number;
  provenanceReceiptValidated: true;
  rightsReceiptIntegrityValidated: true;
  declaredPerformanceWithinHardLimits: boolean;
  performanceMeasured: false;
  shipEligible: false;
  activationEnabled: false;
  creatorExportEnabled: false;
  productionIntegration: false;
  blockers: string[];
}

export function getExperimentalPetPackStatus(): Promise<ExperimentalPetPackStatus> {
  return invoke<ExperimentalPetPackStatus>('get_experimental_petpack_status');
}

export function validateExperimentalPetPack(
  input: ValidatePetPackInput,
): Promise<PetPackValidationReport> {
  return invoke<PetPackValidationReport>('validate_experimental_petpack', { input });
}

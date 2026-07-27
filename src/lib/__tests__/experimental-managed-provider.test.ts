import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  EXPERIMENTAL_MANAGED_PROVIDER_DISPATCH,
  EXPERIMENTAL_MANAGED_PROVIDER_PRODUCTION_INTEGRATION,
  EXPERIMENTAL_MANAGED_PROVIDER_REAL_MONEY,
  createExperimentalManagedRouteContract,
  getExperimentalManagedProviderStatus,
  initializeExperimentalManagedProviderStore,
  recordExperimentalManagedUnknownOutcome,
  registerExperimentalProviderContract,
} from '../experimental-managed-provider';

function productionSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...productionSourceFiles(absolute));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (absolute.endsWith(`${path.sep}experimental-managed-provider.ts`)) continue;
    files.push(absolute);
  }
  return files;
}

describe('experimental managed-provider bridge', () => {
  beforeEach(() => invokeMock.mockReset());

  it('is inert and has no production provider, billing or UI call-site', () => {
    expect(invokeMock).not.toHaveBeenCalled();
    expect(EXPERIMENTAL_MANAGED_PROVIDER_PRODUCTION_INTEGRATION).toBe(false);
    expect(EXPERIMENTAL_MANAGED_PROVIDER_REAL_MONEY).toBe(false);
    expect(EXPERIMENTAL_MANAGED_PROVIDER_DISPATCH).toBe(false);

    const integratedFiles = productionSourceFiles(path.resolve(process.cwd(), 'src')).filter(
      (file) => {
        const source = fs.readFileSync(file, 'utf8');
        return source.includes('experimental-managed-provider')
          || source.includes('get_experimental_managed_provider_status')
          || source.includes('initialize_experimental_managed_provider_store')
          || source.includes('register_experimental_provider_contract')
          || source.includes('create_experimental_managed_route_contract')
          || source.includes('record_experimental_managed_unknown_outcome');
      },
    );
    expect(integratedFiles).toEqual([]);
  });

  it('routes only the five explicit no-effect contract commands', async () => {
    invokeMock.mockResolvedValue({ productionIntegration: false });

    await getExperimentalManagedProviderStatus();
    expect(invokeMock).toHaveBeenLastCalledWith('get_experimental_managed_provider_status');

    await initializeExperimentalManagedProviderStore();
    expect(invokeMock).toHaveBeenLastCalledWith('initialize_experimental_managed_provider_store');

    const provider = {
      recordId: 'por-fixture-openai-1',
      revision: 1,
      contractStatus: 'syntheticValidated' as const,
      providerId: 'openai' as const,
      providerSku: 'openai-fast-fixture',
      modelFamilyId: 'openai-fast-fixture',
      logicalTier: 'fast' as const,
      supplyMode: 'managed' as const,
      servingRegion: 'SG',
      inferenceRegion: 'SG',
      storageRegion: 'SG',
      billingRegion: 'SG',
      pricingSnapshotId: 'price-fixture-v1',
      currency: 'USD',
      credentialReferenceSha256: 'a'.repeat(64),
      evidenceBundleSha256: 'b'.repeat(64),
      idempotencyKey: 'por-fixture',
    };
    await registerExperimentalProviderContract(provider);
    expect(invokeMock).toHaveBeenLastCalledWith('register_experimental_provider_contract', {
      input: provider,
    });

    const route = {
      tenantId: 'tenant-fixture',
      organizationId: 'organization-fixture',
      requestId: 'request-fixture',
      attemptId: 'attempt-fixture',
      executionClass: 'webSearch' as const,
      requestedTier: 'fast' as const,
      modelId: provider.modelFamilyId,
      auxiliaryEligible: true,
      allowPrimaryFallback: false,
      onboardingRecordId: provider.recordId,
      onboardingRevision: provider.revision,
      expectedOnboardingDecisionSha256: 'c'.repeat(64),
      maximumCostMicros: 1_000_000,
      idempotencyKey: 'route-fixture',
    };
    await createExperimentalManagedRouteContract(route);
    expect(invokeMock).toHaveBeenLastCalledWith('create_experimental_managed_route_contract', {
      input: route,
    });

    const unknown = {
      tenantId: route.tenantId,
      organizationId: route.organizationId,
      requestId: route.requestId,
      attemptId: route.attemptId,
      expectedBindingSha256: 'd'.repeat(64),
      reasonSha256: 'e'.repeat(64),
      providerRequestReferenceSha256: 'f'.repeat(64),
      contractSimulation: true as const,
      idempotencyKey: 'unknown-fixture',
    };
    await recordExperimentalManagedUnknownOutcome(unknown);
    expect(invokeMock).toHaveBeenLastCalledWith('record_experimental_managed_unknown_outcome', {
      input: unknown,
    });
  });
});

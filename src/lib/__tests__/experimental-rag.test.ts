import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  EXPERIMENTAL_RAG_PRODUCTION_INTEGRATION,
  changeExperimentalRagSourceConsent,
  createExperimentalRagOrganizationProposal,
  getExperimentalRagConsentStatus,
  initializeExperimentalRagConsentStore,
  registerExperimentalRagSource,
  reviewExperimentalRagOrganizationProposal,
} from '../experimental-rag';

function productionSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...productionSourceFiles(absolute));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (absolute.endsWith(`${path.sep}experimental-rag.ts`)) continue;
    files.push(absolute);
  }
  return files;
}

describe('experimental RAG bridge', () => {
  beforeEach(() => invokeMock.mockReset());

  it('is inert and has no production call-site', () => {
    expect(invokeMock).not.toHaveBeenCalled();
    expect(EXPERIMENTAL_RAG_PRODUCTION_INTEGRATION).toBe(false);

    const integratedFiles = productionSourceFiles(path.resolve(process.cwd(), 'src')).filter((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return source.includes('experimental-rag')
        || source.includes('register_experimental_rag_source')
        || source.includes('change_experimental_rag_source_consent')
        || source.includes('create_experimental_rag_organization_proposal');
    });
    expect(integratedFiles).toEqual([]);
  });

  it('routes only explicit consent and proposal commands', async () => {
    invokeMock.mockResolvedValue({ productionIntegration: false });
    await getExperimentalRagConsentStatus();
    expect(invokeMock).toHaveBeenLastCalledWith('get_experimental_rag_consent_status');

    await initializeExperimentalRagConsentStore();
    expect(invokeMock).toHaveBeenLastCalledWith('initialize_experimental_rag_consent_store');

    const source = {
      sourceId: 'source-1',
      tenantId: 'local',
      ownerUserId: 'user-1',
      sourceKind: 'directory' as const,
      rootPath: '/isolated/knowledge',
      includeGlobs: ['**/*.md'],
      excludeGlobs: ['private/**'],
      idempotencyKey: 'register-1',
    };
    await registerExperimentalRagSource(source);
    expect(invokeMock).toHaveBeenLastCalledWith('register_experimental_rag_source', { input: source });

    const consent = {
      sourceId: 'source-1',
      tenantId: 'local',
      ownerUserId: 'user-1',
      expectedGeneration: 1,
      nextState: 'grantedLocalOnly' as const,
      includeGlobs: ['**/*.md'],
      excludeGlobs: ['private/**'],
      requestId: 'grant-1',
    };
    await changeExperimentalRagSourceConsent(consent);
    expect(invokeMock).toHaveBeenLastCalledWith('change_experimental_rag_source_consent', { input: consent });

    const proposal = {
      proposalId: 'proposal-1',
      tenantId: 'local',
      ownerUserId: 'user-1',
      sourceId: 'source-1',
      expectedGeneration: 2,
      expectedPolicyRevision: 'a'.repeat(64),
      proposalKind: 'tag' as const,
      target: { tag: 'research' },
      evidenceSha256: ['b'.repeat(64)],
      modelId: 'local-fixture',
      promptVersion: 'proposal-v1',
      confidence: 0.9,
      idempotencyKey: 'proposal-1',
    };
    await createExperimentalRagOrganizationProposal(proposal);
    expect(invokeMock).toHaveBeenLastCalledWith('create_experimental_rag_organization_proposal', { input: proposal });

    const review = {
      proposalId: 'proposal-1',
      tenantId: 'local',
      ownerUserId: 'user-1',
      action: 'approve' as const,
      reason: 'User approved this proposal.',
      idempotencyKey: 'review-1',
    };
    await reviewExperimentalRagOrganizationProposal(review);
    expect(invokeMock).toHaveBeenLastCalledWith('review_experimental_rag_organization_proposal', { input: review });
  });
});

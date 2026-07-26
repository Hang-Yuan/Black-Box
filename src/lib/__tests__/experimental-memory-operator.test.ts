import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
  EXPERIMENTAL_MEMORY_OPERATOR_EXECUTION_ADAPTER_AVAILABLE,
  EXPERIMENTAL_MEMORY_OPERATOR_EXECUTION_DISPATCHED,
  EXPERIMENTAL_MEMORY_OPERATOR_ISOLATED_REHEARSAL_ONLY,
  EXPERIMENTAL_MEMORY_OPERATOR_PRODUCTION_INTEGRATION,
  consumeExperimentalMemoryExecutionAuthorizationNoEffect,
  createExperimentalMemoryReviewerSession,
  executeExperimentalMemoryAuthorityRehearsal,
  getExperimentalMemoryOperatorStatus,
  initializeExperimentalMemoryOperator,
  inspectExperimentalMemoryOperatorJournal,
  inspectExperimentalMemoryRehearsalAuthority,
  issueExperimentalMemoryExecutionAuthorization,
  issueExperimentalMemoryRehearsalAuthorization,
  reviewExperimentalMemoryProposal,
  revokeExperimentalMemoryExecutionAuthorization,
} from '../experimental-memory-operator';

function productionSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...productionSourceFiles(absolute));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (absolute.endsWith(`${path.sep}experimental-memory-operator.ts`)) continue;
    files.push(absolute);
  }
  return files;
}

describe('experimental Memory operator bridge', () => {
  beforeEach(() => invokeMock.mockReset());

  it('is inert and has no production or UI call-site', () => {
    expect(EXPERIMENTAL_MEMORY_OPERATOR_EXECUTION_ADAPTER_AVAILABLE).toBe(true);
    expect(EXPERIMENTAL_MEMORY_OPERATOR_EXECUTION_DISPATCHED).toBe(false);
    expect(EXPERIMENTAL_MEMORY_OPERATOR_ISOLATED_REHEARSAL_ONLY).toBe(true);
    expect(EXPERIMENTAL_MEMORY_OPERATOR_PRODUCTION_INTEGRATION).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();

    const integrated = productionSourceFiles(path.resolve(process.cwd(), 'src')).filter((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return source.includes('experimental-memory-operator')
        || source.includes('get_experimental_memory_operator_status')
        || source.includes('initialize_experimental_memory_operator')
        || source.includes('create_experimental_memory_reviewer_session')
        || source.includes('review_experimental_memory_proposal')
        || source.includes('issue_experimental_memory_execution_authorization')
        || source.includes('issue_experimental_memory_rehearsal_authorization')
        || source.includes('revoke_experimental_memory_execution_authorization')
        || source.includes('consume_experimental_memory_execution_authorization_no_effect')
        || source.includes('execute_experimental_memory_authority_rehearsal')
        || source.includes('inspect_experimental_memory_rehearsal_authority')
        || source.includes('inspect_experimental_memory_operator_journal');
    });
    expect(integrated).toEqual([]);
  });

  it('routes only the eleven explicit isolated commands', async () => {
    invokeMock.mockResolvedValue({ productionIntegration: false });
    await getExperimentalMemoryOperatorStatus();
    expect(invokeMock).toHaveBeenLastCalledWith('get_experimental_memory_operator_status');
    await initializeExperimentalMemoryOperator();
    expect(invokeMock).toHaveBeenLastCalledWith('initialize_experimental_memory_operator');

    const reviewerSession = {
      actionKind: 'proposal_review' as const,
      operationId: 'review-1',
      idempotencyKey: 'review-key-1',
      proposalRecordSha256: 'a'.repeat(64),
      decision: 'approve' as const,
      authorizationRecordSha256: null,
      reasonSha256: 'c'.repeat(64),
    };
    await createExperimentalMemoryReviewerSession(reviewerSession);
    expect(invokeMock).toHaveBeenLastCalledWith(
      'create_experimental_memory_reviewer_session',
      { input: reviewerSession },
    );

    const review = {
      operationId: 'review-1', proposalRecordSha256: reviewerSession.proposalRecordSha256,
      decision: 'approve' as const, reviewerSessionToken: 'bbmrs1_payload.signature',
      reviewReasonSha256: reviewerSession.reasonSha256,
      idempotencyKey: 'review-key-1',
    };
    await reviewExperimentalMemoryProposal(review);
    expect(invokeMock).toHaveBeenLastCalledWith('review_experimental_memory_proposal', { input: review });

    const issue = {
      operationId: 'issue-1', reviewRecordSha256: 'd'.repeat(64),
      proposalRecordSha256: review.proposalRecordSha256,
      expectedMemorySha256: 'e'.repeat(64), ttlSeconds: 300, idempotencyKey: 'issue-key-1',
    };
    await issueExperimentalMemoryExecutionAuthorization(issue);
    expect(invokeMock).toHaveBeenLastCalledWith(
      'issue_experimental_memory_execution_authorization', { input: issue },
    );
    await issueExperimentalMemoryRehearsalAuthorization(issue);
    expect(invokeMock).toHaveBeenLastCalledWith(
      'issue_experimental_memory_rehearsal_authorization', { input: issue },
    );

    const revoke = {
      operationId: 'revoke-1', authorizationRecordSha256: 'f'.repeat(64),
      proposalRecordSha256: review.proposalRecordSha256,
      reviewerSessionToken: 'bbmrs1_revocation.signature',
      revocationReasonSha256: '1'.repeat(64), idempotencyKey: 'revoke-key-1',
    };
    await revokeExperimentalMemoryExecutionAuthorization(revoke);
    expect(invokeMock).toHaveBeenLastCalledWith(
      'revoke_experimental_memory_execution_authorization', { input: revoke },
    );

    const consume = {
      operationId: 'consume-1', authorizationRecordSha256: '2'.repeat(64),
      proposalRecordSha256: review.proposalRecordSha256,
      expectedMemorySha256: issue.expectedMemorySha256,
      authorizationToken: `bbm1_${'3'.repeat(64)}`, idempotencyKey: 'consume-key-1',
    };
    await consumeExperimentalMemoryExecutionAuthorizationNoEffect(consume);
    expect(invokeMock).toHaveBeenLastCalledWith(
      'consume_experimental_memory_execution_authorization_no_effect', { input: consume },
    );
    await executeExperimentalMemoryAuthorityRehearsal(consume);
    expect(invokeMock).toHaveBeenLastCalledWith(
      'execute_experimental_memory_authority_rehearsal', { input: consume },
    );

    await inspectExperimentalMemoryOperatorJournal();
    expect(invokeMock).toHaveBeenLastCalledWith('inspect_experimental_memory_operator_journal');
    await inspectExperimentalMemoryRehearsalAuthority();
    expect(invokeMock).toHaveBeenLastCalledWith('inspect_experimental_memory_rehearsal_authority');
  });
});

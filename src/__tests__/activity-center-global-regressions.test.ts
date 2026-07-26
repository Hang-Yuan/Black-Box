import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(__dirname, '../..');
const activityCenter = fs.readFileSync(
  path.join(projectRoot, 'src/components/activity/ActivityCenter.tsx'),
  'utf8',
);
const activityAggregation = fs.readFileSync(
  path.join(projectRoot, 'src/lib/global-task-activity.ts'),
  'utf8',
);
const loopStore = fs.readFileSync(
  path.join(projectRoot, 'src/stores/loopStore.ts'),
  'utf8',
);

describe('global activity center regressions', () => {
  it('never reconstructs global activity from transcripts or tab messages', () => {
    const forbidden = [
      'parseSessionMessages',
      'listSessions',
      'searchSessions',
      'deriveNativeLoopJobs',
      'tab.messages',
    ];
    for (const token of forbidden) {
      expect(activityCenter).not.toContain(token);
      expect(activityAggregation).not.toContain(token);
      expect(loopStore).not.toContain(token);
    }
    expect(activityCenter).not.toContain('session.preview');
  });

  it('opens a thread through the injected callback and keeps task families expandable', () => {
    expect(activityCenter).toContain('onOpenThread(row.threadId)');
    expect(activityCenter).toContain('expandedThreads');
    expect(activityCenter).toContain("['plan', 'workflow', 'loop']");
    expect(activityCenter).toContain('data-activity-thread-id');
    expect(activityCenter).toContain('data-activity-detail-kind');
  });

  it('keeps automation rows separate and accepts only a redacted prop summary', () => {
    expect(activityCenter).toContain('automations?: readonly AutomationActivitySummary[]');
    expect(activityCenter).toContain('data-activity-automation-id');
    expect(activityCenter).not.toContain('bridge.listAutomations');
    expect(activityAggregation).not.toMatch(/AutomationActivitySummary[\s\S]{0,500}\bprompt\b/);
    expect(activityAggregation).not.toMatch(/AutomationActivitySummary[\s\S]{0,500}\bcwds\b/);
  });

  it('documents the bounded, six-field Loop persistence contract', () => {
    expect(loopStore).toContain('LOOP_LEDGER_MAX_RECORDS = 200');
    expect(loopStore).toContain('7 * 24 * 60 * 60 * 1_000');
    expect(loopStore).toContain("candidate.status === 'running'");
    expect(loopStore).toContain("? 'resume_pending'");
    expect(loopStore).toContain('moveJobs: (oldThreadId: string, newThreadId: string)');
    expect(loopStore).not.toContain('prompt:');
    expect(loopStore).not.toContain('messages:');
  });

});

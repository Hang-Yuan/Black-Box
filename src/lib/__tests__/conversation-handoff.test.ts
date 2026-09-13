import { describe, expect, it } from 'vitest';
import { buildConversationHandoff, formatHandoffSummary, validateHandoffSummary, type GeneratedHandoff } from '../conversation-handoff';
import { projectContextPressure } from '../context-recovery';

const handoff: GeneratedHandoff = {
  sourceDigest: 'digest', sourcePath: '/sessions/source.jsonl', sourceCwd: '/project', generationInputTokens: 100_000,
  summary: {
    goal: '完成知识库接入', constraints: ['暂不修改服务器配置'],
    completed: ['回滚已验证通过；证据 evidence/restore.json'], pending: ['提交平台报告或统一路径'],
    pendingDecisions: ['用户尚未选择报告或路径统一'], references: [{ location: 'evidence/restore.json', purpose: '回滚验证结果' }],
    nextStep: '询问用户选择哪一项',
  },
};

describe('bounded task-state handoff', () => {
  it('carries completed evidence and unresolved choices without the old transcript', () => {
    const draft = buildConversationHandoff(handoff, '项目v1开发', 'zh');
    expect(draft).toContain('回滚已验证通过');
    expect(draft).toContain('先提出待决问题');
    expect(draft).toContain('evidence/restore.json');
    expect(draft).toContain('/sessions/source.jsonl');
    expect(draft).not.toContain('100000'); // generation context never becomes the continuation input
    expect(draft.length).toBeLessThan(1000);
  });
  it('permits only the next authorized step when there is no pending choice', () => {
    const ready = { ...handoff, summary: { ...handoff.summary, pendingDecisions: [], nextStep: 'Write approved report' } };
    const draft = buildConversationHandoff(ready, 'Project', 'en');
    expect(draft).toContain('only the next authorized, unfinished step');
    expect(draft).not.toContain('User decisions are pending');
    expect(draft).toContain('Completed');
  });
  it('rejects excessive or incomplete summaries instead of silently cutting conclusions', () => {
    const long = { ...handoff.summary, completed: ['x'.repeat(3001)] };
    expect(validateHandoffSummary(long)).toBe(false);
    expect(() => formatHandoffSummary(long, 'zh')).toThrow();
    expect(validateHandoffSummary({ ...handoff.summary, nextStep: '' })).toBe(false);
    expect(validateHandoffSummary({ ...handoff.summary, references: undefined } as any)).toBe(false);
    expect(validateHandoffSummary({ ...handoff.summary, constraints: Array(9).fill('item') })).toBe(false);
  });
  it('checks the UTF-8 budget as well as the character count', () => {
    const dense = { ...handoff.summary, completed: ['中'.repeat(2700)] };
    expect(validateHandoffSummary(dense)).toBe(false);
    expect(validateHandoffSummary(handoff.summary)).toBe(true);
  });
  it('does not recursively append previous handoff packages', () => {
    const second = { ...handoff, sourcePath: '/sessions/second.jsonl', summary: { ...handoff.summary, goal: '下一阶段' } };
    const text = buildConversationHandoff(second, '项目v1开发2', 'zh');
    expect(text).not.toContain('/sessions/source.jsonl');
    expect(text.match(/原始记录/g)).toHaveLength(1);
  });
});

describe('context occupancy and advice', () => {
  it('reports the observed 120385-token case as 60 percent without high-usage advice', () => {
    expect(projectContextPressure(120385, 200000)).toMatchObject({ percent: 60, visible: true, high: false });
    expect(projectContextPressure(160000, 200000)).toMatchObject({ percent: 80, high: true });
    expect(projectContextPressure(120385, 1000000)).toMatchObject({ percent: 12, visible: false, high: false });
  });
  it('does not manufacture usage from unavailable or invalid values', () => {
    expect(projectContextPressure(NaN, 200000)).toMatchObject({ used: 0, visible: false });
    expect(projectContextPressure(-1, 200000)).toMatchObject({ used: 0, visible: false });
  });
});

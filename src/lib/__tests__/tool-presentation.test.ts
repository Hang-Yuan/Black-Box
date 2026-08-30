import { describe, expect, it } from 'vitest';
import {
  buildSemanticToolSummary,
  getToolSemanticDescription,
} from '../tool-presentation';

describe('tool presentation', () => {
  it('uses a clean Bash description as the human-readable title', () => {
    expect(getToolSemanticDescription('Bash', {
      command: 'octopus-cli arcubase inspect --json',
      description: '  读取\nArcubase   运行状态  ',
    })).toBe('读取 Arcubase 运行状态');
    expect(getToolSemanticDescription('Read', { description: '读取文件' })).toBeNull();
  });

  it('preserves the harness description instead of guessing a translation', () => {
    expect(getToolSemanticDescription('Bash', {
      description: 'Inspect one brain employee config fields',
    })).toBe('Inspect one brain employee config fields');
  });

  it('redacts common credential shapes before displaying descriptions', () => {
    const description = getToolSemanticDescription('Bash', {
      description: 'Call API with Bearer secret-value and api_key=sk-example123456',
    });
    expect(description).toContain('Bearer •••');
    expect(description).toContain('api_key=•••');
    expect(description).not.toContain('secret-value');
    expect(description).not.toContain('sk-example');
  });

  it('summarizes distinct Bash actions and keeps a raw-tool fallback', () => {
    const summary = buildSemanticToolSummary([
      { toolName: 'Bash', toolInput: { description: '检查 Octopus 命令' } },
      { toolName: 'Bash', toolInput: { description: '读取 Arcubase 状态' } },
      { toolName: 'Read', toolInput: { file_path: '/tmp/a' } },
      { toolName: 'Bash', toolInput: { command: 'pwd' } },
      { toolName: 'Bash', toolInput: { command: 'git status' } },
      { toolName: 'Edit', toolInput: { file_path: '/tmp/a' } },
    ]);

    expect(summary).toBe('Bash：检查 Octopus 命令, Bash：读取 Arcubase 状态, Read, +3');
  });

  it('groups repeated descriptions without exposing raw commands', () => {
    const summary = buildSemanticToolSummary([
      { toolName: 'Bash', toolInput: { description: '运行回归', command: 'secret-one' } },
      { toolName: 'Bash', toolInput: { description: '运行回归', command: 'secret-two' } },
    ]);
    expect(summary).toBe('Bash：运行回归 ×2');
    expect(summary).not.toContain('secret');
  });
});

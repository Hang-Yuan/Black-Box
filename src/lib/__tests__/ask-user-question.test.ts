import { describe, expect, it } from 'vitest';
import {
  buildAskUserQuestionAnswers,
  type AskUserQuestionInput,
} from '../ask-user-question';

const questions: AskUserQuestionInput[] = [
  {
    question: 'Which scope?',
    options: [{ label: 'Current project' }, { label: 'All projects' }],
  },
  {
    question: 'Which checks?',
    options: [{ label: 'Tests' }, { label: 'Types' }, { label: 'Formatting' }],
  },
  {
    question: 'Any constraint?',
    options: [{ label: 'No network' }],
  },
];

describe('AskUserQuestion SDK answers', () => {
  it('keys answers by the exact question text and joins multi-select labels', () => {
    expect(buildAskUserQuestionAnswers(questions, {
      selectedMap: {
        0: new Set([1]),
        1: new Set([0, 2]),
      },
      useOther: {},
      otherText: {},
    })).toEqual({
      'Which scope?': 'All projects',
      'Which checks?': 'Tests, Formatting',
    });
  });

  it('lets Other override selected options and omits unanswered questions', () => {
    expect(buildAskUserQuestionAnswers(questions, {
      selectedMap: {
        0: new Set([0]),
        1: new Set([1]),
      },
      useOther: { 1: true, 2: true },
      otherText: { 1: '  Run the release audit  ', 2: '   ' },
    })).toEqual({
      'Which scope?': 'Current project',
      'Which checks?': 'Run the release audit',
    });
  });

  it('ignores malformed option indexes instead of emitting empty answers', () => {
    expect(buildAskUserQuestionAnswers(questions, {
      selectedMap: { 0: new Set([99]) },
      useOther: {},
      otherText: {},
    })).toEqual({});
  });
});

export interface AskUserQuestionOption {
  label?: string;
}

export interface AskUserQuestionInput {
  question: string;
  options: AskUserQuestionOption[];
}

export interface AskUserQuestionAnswerState {
  selectedMap: Partial<Record<number, ReadonlySet<number>>>;
  useOther: Partial<Record<number, boolean>>;
  otherText: Partial<Record<number, string>>;
}

/**
 * Build the `updatedInput.answers` payload expected by Claude Code's
 * AskUserQuestion control protocol.
 *
 * Claude Code indexes answers by the exact question text, not by the
 * question's numeric position. Numeric keys are accepted by TypeScript but
 * are rendered by the SDK as "The user did not answer the questions."
 */
export function buildAskUserQuestionAnswers(
  questions: readonly AskUserQuestionInput[],
  state: AskUserQuestionAnswerState,
): Record<string, string> {
  const answers: Record<string, string> = {};

  questions.forEach((question, questionIndex) => {
    const customAnswer = state.useOther[questionIndex]
      ? state.otherText[questionIndex]?.trim()
      : undefined;
    if (customAnswer) {
      answers[question.question] = customAnswer;
      return;
    }

    const labels = Array.from(state.selectedMap[questionIndex] ?? [])
      .map((optionIndex) => question.options[optionIndex]?.label)
      .filter((label): label is string => typeof label === 'string' && label.length > 0);
    if (labels.length > 0) answers[question.question] = labels.join(', ');
  });

  return answers;
}

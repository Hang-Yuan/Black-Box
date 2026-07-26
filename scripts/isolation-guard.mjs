import { existsSync, readFileSync } from 'node:fs';
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path';

function isSameOrInside(candidate, root) {
  const relation = relative(root, candidate);
  return relation === ''
    || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

export function configuredPrivateRoots(projectRoot) {
  const configured = String(process.env.BLACKBOX_PRIVATE_ROOTS || '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([projectRoot, ...configured].map((value) => resolve(value)))];
}

export function assertExternalExecutionRoot(executionRoot, privateRoots) {
  const resolvedExecutionRoot = resolve(executionRoot);
  const hit = privateRoots.find((root) => isSameOrInside(resolvedExecutionRoot, root));
  if (hit) {
    throw new Error(
      `Model execution root must be outside private/source roots: ${resolvedExecutionRoot}`,
    );
  }
}

export function assertNoPrivateToolAccess(jsonlPath, privateRoots) {
  if (!jsonlPath || !existsSync(jsonlPath)) {
    throw new Error('Session JSONL is unavailable for isolation audit');
  }

  const extraSentinels = String(process.env.BLACKBOX_PRIVATE_SENTINELS || '')
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  const forbidden = [...new Set([
    ...privateRoots.flatMap((root) => [root, root.replaceAll('\\', '/')]),
    ...extraSentinels,
  ])];
  const toolInputs = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'tool_use') toolInputs.push(JSON.stringify(value.input || {}));
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };

  for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      visit(JSON.parse(line));
    } catch {
      throw new Error('Session JSONL contains an invalid record during isolation audit');
    }
  }

  const hit = forbidden.find((value) => toolInputs.some((input) => input.includes(value)));
  if (hit) throw new Error('Isolation audit found forbidden private/source tool access');
}

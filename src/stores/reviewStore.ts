import { create } from 'zustand';
import { bridge } from '../lib/tauri-bridge';

export type ReviewCommentSide = 'old' | 'new';

export interface ReviewComment {
  id: string;
  runId: string;
  baseCommit: string;
  path: string;
  displayPath: string;
  side: ReviewCommentSide;
  line: number;
  lineText: string;
  body: string;
  resolved: boolean;
  createdAt: number;
  updatedAt: number;
}

type NewReviewComment = Omit<ReviewComment, 'id' | 'resolved' | 'createdAt' | 'updatedAt'>;

interface ReviewState {
  comments: Record<string, ReviewComment>;
  loaded: boolean;
  loadComments: () => Promise<void>;
  addComment: (input: NewReviewComment) => ReviewComment;
  removeComment: (id: string) => void;
  setResolved: (id: string, resolved: boolean) => void;
}

const MAX_COMMENTS = 1_000;
const MAX_BODY_LENGTH = 4_000;
const MAX_PATH_LENGTH = 4_096;
const MAX_LINE_TEXT_LENGTH = 2_000;
let writeQueue: Promise<void> = Promise.resolve();

function normalizeString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeLineText(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/\r\n?/g, '\n').slice(0, MAX_LINE_TEXT_LENGTH)
    : '';
}

function safeRelativePath(value: string): boolean {
  if (!value || value.startsWith('/') || /^[A-Za-z]:[/\\]/.test(value)) return false;
  return value.split(/[\\/]/).every((part) => part && part !== '.' && part !== '..');
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

function normalizeComment(id: string, value: unknown): ReviewComment | null {
  if (!isSafeId(id) || !value || typeof value !== 'object') return null;
  const candidate = value as Partial<ReviewComment>;
  const runId = normalizeString(candidate.runId, 160);
  const baseCommit = normalizeString(candidate.baseCommit, 80);
  const path = normalizeString(candidate.path, MAX_PATH_LENGTH);
  const displayPath = normalizeString(candidate.displayPath, MAX_PATH_LENGTH) || path;
  // Keep source indentation intact: it is part of the review anchor and helps
  // the model relocate a comment when later edits move the original line.
  const lineText = normalizeLineText(candidate.lineText);
  const body = normalizeString(candidate.body, MAX_BODY_LENGTH);
  const line = Number(candidate.line);
  const createdAt = Number(candidate.createdAt);
  const updatedAt = Number(candidate.updatedAt);
  if (!isSafeId(runId)
    || !safeRelativePath(path)
    || !body
    || !['old', 'new'].includes(String(candidate.side))
    || !Number.isInteger(line)
    || line < 1
    || line > 10_000_000
    || !Number.isFinite(createdAt)
    || !Number.isFinite(updatedAt)) {
    return null;
  }
  return {
    id,
    runId,
    baseCommit,
    path,
    displayPath,
    side: candidate.side as ReviewCommentSide,
    line,
    lineText,
    body,
    resolved: candidate.resolved === true,
    createdAt,
    updatedAt,
  };
}

function trimComments(comments: Record<string, ReviewComment>): Record<string, ReviewComment> {
  return Object.fromEntries(
    Object.values(comments)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_COMMENTS)
      .map((comment) => [comment.id, comment]),
  );
}

function sanitizeComments(value: unknown): Record<string, ReviewComment> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const comments: Record<string, ReviewComment> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const comment = normalizeComment(id, raw);
    if (comment) comments[id] = comment;
  }
  return trimComments(comments);
}

function persist(comments: Record<string, ReviewComment>): void {
  const snapshot = JSON.parse(JSON.stringify(comments)) as Record<string, ReviewComment>;
  writeQueue = writeQueue
    .catch(() => {})
    .then(() => bridge.saveReviewComments(snapshot))
    .catch((error) => console.warn('[BLACKBOX Review] Failed to persist comments:', error));
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `review_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export const useReviewStore = create<ReviewState>()((set, get) => ({
  comments: {},
  loaded: false,

  loadComments: async () => {
    try {
      const comments = sanitizeComments(await bridge.loadReviewComments());
      set({ comments, loaded: true });
      persist(comments);
    } catch (error) {
      console.warn('[BLACKBOX Review] Failed to load comments:', error);
      set({ loaded: true });
    }
  },

  addComment: (input) => {
    const now = Date.now();
    const id = newId();
    const comment = normalizeComment(id, {
      ...input,
      resolved: false,
      createdAt: now,
      updatedAt: now,
    });
    if (!comment) throw new Error('Review comment is invalid or exceeds a safety limit');
    const comments = trimComments({ ...get().comments, [id]: comment });
    set({ comments });
    persist(comments);
    return comment;
  },

  removeComment: (id) => {
    if (!get().comments[id]) return;
    const comments = { ...get().comments };
    delete comments[id];
    set({ comments });
    persist(comments);
  },

  setResolved: (id, resolved) => {
    const current = get().comments[id];
    if (!current || current.resolved === resolved) return;
    const comments = {
      ...get().comments,
      [id]: { ...current, resolved, updatedAt: Date.now() },
    };
    set({ comments });
    persist(comments);
  },
}));

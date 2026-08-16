export const CONVERSATION_SIDEBAR_VISIBILITY_KEY =
  'blackbox.conversation-sidebar-visibility.v1';

export interface ConversationSidebarVisibility {
  activeExpandedProjects: string[];
  activeCollapsedProjects: string[];
  activeCollapsedGroups: string[];
  archiveCollapsedProjects: string[];
  archiveExpandedGroups: string[];
}

const EMPTY_VISIBILITY: ConversationSidebarVisibility = {
  activeExpandedProjects: [],
  activeCollapsedProjects: [],
  activeCollapsedGroups: [],
  archiveCollapsedProjects: [],
  archiveExpandedGroups: [],
};

type SidebarVisibilityStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): SidebarVisibilityStorage | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is string => (
    typeof item === 'string' && item.length > 0
  ))));
}

export function loadConversationSidebarVisibility(
  storage: SidebarVisibilityStorage | null = browserStorage(),
): ConversationSidebarVisibility {
  if (!storage) return { ...EMPTY_VISIBILITY };
  try {
    const raw = storage.getItem(CONVERSATION_SIDEBAR_VISIBILITY_KEY);
    if (!raw) return { ...EMPTY_VISIBILITY };
    const parsed = JSON.parse(raw) as Partial<ConversationSidebarVisibility>;
    return {
      activeExpandedProjects: stringArray(parsed.activeExpandedProjects),
      activeCollapsedProjects: stringArray(parsed.activeCollapsedProjects),
      activeCollapsedGroups: stringArray(parsed.activeCollapsedGroups),
      archiveCollapsedProjects: stringArray(parsed.archiveCollapsedProjects),
      archiveExpandedGroups: stringArray(parsed.archiveExpandedGroups),
    };
  } catch {
    return { ...EMPTY_VISIBILITY };
  }
}

export function saveConversationSidebarVisibility(
  visibility: ConversationSidebarVisibility,
  storage: SidebarVisibilityStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(CONVERSATION_SIDEBAR_VISIBILITY_KEY, JSON.stringify({
      activeExpandedProjects: stringArray(visibility.activeExpandedProjects).sort(),
      activeCollapsedProjects: stringArray(visibility.activeCollapsedProjects).sort(),
      activeCollapsedGroups: stringArray(visibility.activeCollapsedGroups).sort(),
      archiveCollapsedProjects: stringArray(visibility.archiveCollapsedProjects).sort(),
      archiveExpandedGroups: stringArray(visibility.archiveExpandedGroups).sort(),
    }));
  } catch {
    // Expansion state is a UI convenience. Storage failures must never block chat.
  }
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('session metadata authority regressions', () => {
  const conversations = source('components/conversations/ConversationList.tsx');
  const persistence = source('stores/groupPersistence.ts');
  const bridge = source('lib/tauri-bridge.ts');
  const generalSettings = source('components/settings/GeneralTab.tsx');
  const rustMetadata = source('../src-tauri/src/session_metadata.rs');
  const rustEntry = source('../src-tauri/src/lib.rs');

  it('keeps disk metadata authoritative instead of reviving localStorage caches', () => {
    expect(conversations).not.toContain('blackbox_pinned_sessions');
    expect(conversations).not.toContain('blackbox_archived_sessions');
    expect(conversations).toContain('enqueuePinnedMetadata');
    expect(conversations).toContain('enqueueArchivedMetadata');
    expect(bridge).toContain('session_metadata.json authority');
  });

  it('serializes complete task-group snapshots and hydrates an intentionally empty ledger', () => {
    expect(persistence).toContain('groupSaveQueue = groupSaveQueue');
    expect(persistence).toContain('if (Array.isArray(data))');
    expect(persistence).not.toContain('data.length > 0');
  });

  it('keeps archive groups collapsed without displaying an ever-growing total', () => {
    expect(conversations).toContain('setArchiveExpandedGroups(new Set())');
    expect(conversations).toContain("conversationView === 'archived'");
    expect(conversations).toContain("['archived', t('conv.archivedView')]");
    expect(conversations).toContain('<span className="truncate">{label}</span>');
    expect(conversations).not.toContain("t('conv.archivedView').replace");
  });

  it('exports and preview-merges portable organization without conversation content', () => {
    expect(rustMetadata).toContain('blackbox-session-organization');
    expect(rustMetadata).toContain('preview_session_organization_import_in');
    expect(rustMetadata).toContain('merge_portable_bundle');
    expect(rustMetadata).toContain('cleared_custom_preview_ids');
    expect(rustMetadata).not.toContain('conversation_jsonl');
    expect(rustEntry).toContain('export_session_organization');
    expect(rustEntry).toContain('preview_session_organization_import');
    expect(rustEntry).toContain('import_session_organization');
    expect(bridge).toContain("invoke<SessionOrganizationReport>('export_session_organization'");
    expect(bridge).toContain("invoke<SessionOrganizationReport>('preview_session_organization_import'");
    expect(bridge).toContain("invoke<SessionOrganizationReport>('import_session_organization'");
  });

  it('exposes a safe settings flow and refreshes every sidebar projection after import', () => {
    expect(generalSettings).toContain('data-testid="session-organization-transfer"');
    expect(generalSettings).toContain('bridge.previewSessionOrganizationImport(selected)');
    expect(generalSettings).toContain('bridge.importSessionOrganization(selected)');
    expect(generalSettings).toContain("kind: 'warning'");
    expect(generalSettings).toContain("new CustomEvent('blackbox:session-organization-imported')");
    expect(conversations).toContain("window.addEventListener('blackbox:session-organization-imported'");
    expect(conversations).toContain('loadCustomPreviewsFromDisk()');
    expect(conversations).toContain('initGroupPersistence()');
  });
});

import { bridge } from '../lib/tauri-bridge';
import { useGroupStore, type SessionGroup } from './groupStore';

let saveSubscribed = false;
let groupSaveQueue: Promise<void> = Promise.resolve();

/**
 * Hydrate the task-group projection from Black Box's unified session metadata
 * authority, then keep that authority in sync on every change. Group order,
 * member order, and in-group pins are written atomically together with the
 * tombstones that protect user removals from stale legacy imports.
 */
export async function initGroupPersistence(): Promise<void> {
  const data = await bridge.loadSessionGroups();
  if (Array.isArray(data)) {
    useGroupStore.setState({ groups: data as SessionGroup[] });
  }

  // Subscribe exactly once: every later store mutation writes back to disk.
  // Registered after the initial hydrate so loading doesn't trigger a save.
  if (!saveSubscribed) {
    saveSubscribed = true;
    useGroupStore.subscribe((state) => {
      const snapshot = state.groups;
      // Tauri commands may execute concurrently. Serialize complete group
      // snapshots so an older create/rename cannot land after a newer reorder.
      groupSaveQueue = groupSaveQueue
        .then(() => bridge.saveSessionGroups(snapshot))
        .catch((error) => {
          console.error('[BLACKBOX Metadata] Failed to persist session groups:', error);
        });
    });
  }
}

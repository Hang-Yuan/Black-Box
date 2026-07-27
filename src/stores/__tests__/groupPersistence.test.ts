import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/tauri-bridge', () => ({
  bridge: {
    loadSessionGroups: vi.fn(),
    saveSessionGroups: vi.fn(),
  },
}));

import { bridge } from '../../lib/tauri-bridge';
import { useGroupStore } from '../groupStore';
import { initGroupPersistence } from '../groupPersistence';

describe('groupPersistence', () => {
  beforeEach(() => {
    useGroupStore.setState({ groups: [] });
    vi.clearAllMocks();
  });

  it('hydrates the store from disk on init', async () => {
    (bridge.loadSessionGroups as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'g1', label: '存档组', workspace: '~/ws', sessionIds: ['s1'], pinnedInGroup: [] },
    ]);
    await initGroupPersistence();
    const groups = useGroupStore.getState().getGroupsForWorkspace('~/ws');
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('存档组');
  });

  it('tolerates an empty / missing groups file', async () => {
    useGroupStore.setState({
      groups: [
        { id: 'stale', label: '旧缓存', workspace: '~/ws', sessionIds: ['s1'], pinnedInGroup: [] },
      ],
    });
    (bridge.loadSessionGroups as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await initGroupPersistence();
    expect(useGroupStore.getState().groups).toEqual([]);
  });

  it('writes back to disk when the store changes', async () => {
    (bridge.loadSessionGroups as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await initGroupPersistence();
    (bridge.saveSessionGroups as ReturnType<typeof vi.fn>).mockClear();
    useGroupStore.getState().createGroup('~/ws', '新组');
    await vi.waitFor(() => expect(bridge.saveSessionGroups).toHaveBeenCalled());
  });
});

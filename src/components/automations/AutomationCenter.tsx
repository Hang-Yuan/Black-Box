import { useSettingsStore } from '../../stores/settingsStore';
import { AutomationsTab } from '../settings/AutomationsTab';

export function AutomationCenter() {
  const setMainView = useSettingsStore((state) => state.setMainView);

  return (
    <div className="h-full overflow-y-auto" data-testid="automation-center">
      <div className="mx-auto max-w-6xl px-8 py-10">
        <AutomationsTab standalone onClose={() => setMainView('chat')} />
      </div>
    </div>
  );
}

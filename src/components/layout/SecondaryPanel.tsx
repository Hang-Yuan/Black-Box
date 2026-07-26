import { useSettingsStore, SecondaryPanelTab } from '../../stores/settingsStore';
import { FileExplorer } from '../files/FileExplorer';
import { ActivityPanel } from '../activity/ActivityPanel';
import { useT } from '../../lib/i18n';

const tabs: { id: SecondaryPanelTab; labelKey: string; vb: string; d: string[] }[] = [
  {
    id: 'activity', labelKey: 'panel.activity', vb: '0 0 16 16', d: [
      'M2 2.5h12v1H2zM2 7.5h12v1H2zM2 12.5h12v1H2z',
      'M5 1.5h2v3H5zM10 6.5h2v3h-2zM4 11.5h2v3H4z',
    ],
  },
  {
    id: 'files', labelKey: 'panel.files', vb: '0 0 1024 1024', d: [
      'M921.6 450.133333c-6.4-8.533333-14.933333-12.8-25.6-12.8h-10.666667V341.333333c0-40.533333-34.133333-74.666667-74.666666-74.666666H514.133333c-4.266667 0-6.4-2.133333-8.533333-4.266667l-38.4-66.133333c-12.8-21.333333-38.4-36.266667-64-36.266667H170.666667c-40.533333 0-74.666667 34.133333-74.666667 74.666667v597.333333c0 6.4 2.133333 12.8 6.4 19.2 6.4 8.533333 14.933333 12.8 25.6 12.8h640c12.8 0 25.6-8.533333 29.866667-21.333333l128-362.666667c4.266667-10.666667 2.133333-21.333333-4.266667-29.866667zM170.666667 224h232.533333c4.266667 0 6.4 2.133333 8.533333 4.266667l38.4 66.133333c12.8 21.333333 38.4 36.266667 64 36.266667H810.666667c6.4 0 10.666667 4.266667 10.666666 10.666666v96H256c-12.8 0-25.6 8.533333-29.866667 21.333334l-66.133333 185.6V234.666667c0-6.4 4.266667-10.666667 10.666667-10.666667z m573.866666 576H172.8l104.533333-298.666667h571.733334l-104.533334 298.666667z',
    ],
  },
];

export function SecondaryPanel() {
  const t = useT();
  const activeTab = useSettingsStore((s) => s.secondaryPanelTab);
  const setTab = useSettingsStore((s) => s.setSecondaryTab);
  const togglePanel = useSettingsStore((s) => s.toggleSecondaryPanel);

  // Window dragging handled via CSS -webkit-app-region: drag on the top strip

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar — extra top padding for macOS traffic lights */}
      <div
        className="flex items-center justify-between px-2 pt-6 pb-2
        border-b border-border-subtle cursor-default">
        <div className="flex gap-1 min-w-0 overflow-hidden">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setTab(tab.id)}
              className={`px-2.5 py-1.5 rounded-md text-[13px] font-medium
                transition-smooth flex items-center gap-1.5 whitespace-nowrap flex-shrink-0
                ${activeTab === tab.id
                  ? 'bg-accent/10 text-accent'
                  : 'text-text-muted hover:bg-bg-secondary hover:text-text-primary'
                }`}
            >
              <svg width="13" height="13" viewBox={tab.vb} fill="currentColor"
                className="flex-shrink-0">
                {tab.d.map((d, i) => <path key={i} d={d} />)}
              </svg>
              {t(tab.labelKey)}
            </button>
          ))}
        </div>
        <button onClick={togglePanel}
          className="p-1 rounded-md hover:bg-bg-tertiary
            text-text-tertiary transition-smooth" title={t('panel.close')}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
            stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4l6 6M10 4l-6 6" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'activity' && <ActivityPanel />}
        {activeTab === 'files' && <FileExplorer />}
      </div>
    </div>
  );
}

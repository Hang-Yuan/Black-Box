import { useEffect, useMemo, useState } from 'react';
import { useCommandStore } from '../../stores/commandStore';
import { useFileStore } from '../../stores/fileStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSkillStore } from '../../stores/skillStore';
import type { SkillInfo } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';
import { McpTab } from '../settings/McpTab';
import { PluginsTab } from '../settings/PluginsTab';
import { AgentCatalog } from './AgentCatalog';
import { HookCatalog } from './HookCatalog';
import { WorkflowCatalog } from './WorkflowCatalog';

type ExtensionSection = 'plugins' | 'skills' | 'workflows' | 'mcp' | 'agents' | 'hooks';

const SECTIONS: Array<{ id: ExtensionSection; labelKey: string }> = [
  { id: 'plugins', labelKey: 'extensions.plugins' },
  { id: 'skills', labelKey: 'extensions.skills' },
  { id: 'workflows', labelKey: 'extensions.workflows' },
  { id: 'mcp', labelKey: 'extensions.mcp' },
  { id: 'agents', labelKey: 'extensions.agents' },
  { id: 'hooks', labelKey: 'extensions.hooks' },
];

function ExtensionGlyph({ kind, size = 18 }: { kind: 'plugins' | 'skills' | 'workflows' | 'mcp' | 'agents' | 'hooks'; size?: number }) {
  if (kind === 'skills') {
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round">
        <path d="M9 1.8 2.2 5.2 9 8.6l6.8-3.4L9 1.8Z" />
        <path d="m2.2 9.2 6.8 3.4 6.8-3.4M2.2 13.1 9 16.5l6.8-3.4" />
      </svg>
    );
  }
  if (kind === 'mcp') {
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round">
        <rect x="1.8" y="3" width="14.4" height="4.4" rx="1.4" />
        <rect x="1.8" y="10.6" width="14.4" height="4.4" rx="1.4" />
        <circle cx="5" cy="5.2" r=".7" fill="currentColor" stroke="none" />
        <circle cx="5" cy="12.8" r=".7" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (kind === 'workflows') {
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="4" cy="4" r="1.8" /><circle cx="14" cy="9" r="1.8" /><circle cx="4" cy="14" r="1.8" />
        <path d="M5.8 4h2.1c2 0 2.5 1.2 2.5 2.5S11 9 12.2 9M5.8 14h2.1c2 0 2.5-1.2 2.5-2.5S11 9 12.2 9" />
      </svg>
    );
  }
  if (kind === 'agents') {
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round">
        <circle cx="9" cy="5.2" r="2.5" />
        <circle cx="4" cy="8.2" r="1.8" />
        <circle cx="14" cy="8.2" r="1.8" />
        <path d="M4.7 15c.5-2.4 2-3.7 4.3-3.7s3.8 1.3 4.3 3.7M1.7 14c.2-1.8 1.1-2.8 2.8-3M16.3 14c-.2-1.8-1.1-2.8-2.8-3" />
      </svg>
    );
  }
  if (kind === 'hooks') {
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.2 2.1v8.3a4 4 0 1 1-4-4" />
        <path d="m6.9 4.3 2.3-2.2 2.2 2.2" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.2 2.2h3.6v3.1h3v3.5h-3v3h-3.6v-3h-3V5.3h3V2.2Z" />
      <path d="M7.2 2.2a1.8 1.8 0 0 1 3.6 0M13.8 5.3a1.75 1.75 0 0 1 0 3.5M10.8 11.8a1.8 1.8 0 0 1-3.6 0M4.2 8.8a1.75 1.75 0 0 1 0-3.5" />
    </svg>
  );
}

function SkillsCatalog() {
  const t = useT();
  const workingDirectory = useSettingsStore((state) => state.workingDirectory);
  const setMainView = useSettingsStore((state) => state.setMainView);
  const skills = useSkillStore((state) => state.skills);
  const loading = useSkillStore((state) => state.isLoading);
  const fetchSkills = useSkillStore((state) => state.fetchSkills);
  const toggleEnabled = useSkillStore((state) => state.toggleEnabled);
  const [query, setQuery] = useState('');

  useEffect(() => {
    void fetchSkills(workingDirectory || undefined);
  }, [fetchSkills, workingDirectory]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return skills
      .filter((skill) => !normalized || [skill.name, skill.description, skill.scope]
        .some((value) => value.toLowerCase().includes(normalized)))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
  }, [query, skills]);

  const useSkill = (skill: SkillInfo) => {
    useCommandStore.getState().setActivePrefix({
      name: `/${skill.name}`,
      description: skill.description,
      source: skill.scope,
      category: 'skill',
      has_args: true,
      path: skill.path,
      immediate: false,
    });
    setMainView('chat');
  };

  const openSkill = (skill: SkillInfo) => {
    useFileStore.getState().selectFile(skill.path);
    setMainView('chat');
    useSettingsStore.getState().setSecondaryTab('files');
  };

  return (
    <div className="space-y-5" data-testid="extension-skills-catalog">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[260px] flex-1">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary">
            <circle cx="7" cy="7" r="5" />
            <path d="m11 11 3 3" />
          </svg>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('extensions.searchSkills')}
            className="w-full rounded-xl border border-border-subtle bg-bg-secondary/45 py-2.5 pl-9 pr-3 text-[12px] text-text-primary outline-none transition-smooth placeholder:text-text-tertiary focus:border-accent/60 focus:bg-bg-secondary"
          />
        </div>
        <button
          type="button"
          onClick={() => void fetchSkills(workingDirectory || undefined)}
          disabled={loading}
          className="rounded-lg border border-border-subtle px-3 py-2 text-[11px] text-text-muted transition-smooth hover:bg-bg-secondary hover:text-text-primary disabled:opacity-50"
        >
          {loading ? t('plugins.loading') : t('plugins.refresh')}
        </button>
      </div>

      {loading && skills.length === 0 ? (
        <div className="flex justify-center py-16"><div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/25 border-t-accent" /></div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border-subtle py-16 text-center text-[12px] text-text-tertiary">
          {query ? t('extensions.noSkillMatches') : t('skills.empty')}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {filtered.map((skill) => {
            const enabled = skill.disable_model_invocation !== true;
            return (
              <article key={skill.path} className="rounded-2xl border border-border-subtle bg-bg-secondary/35 p-4 transition-smooth hover:border-accent/25 hover:bg-bg-secondary/55">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                    <ExtensionGlyph kind="skills" size={19} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-[13px] font-semibold text-text-primary">{skill.name}</h3>
                      <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[9px] uppercase text-text-tertiary">{skill.scope}</span>
                      <span className={`text-[9px] font-medium ${enabled ? 'text-emerald-500' : 'text-text-tertiary'}`}>
                        {enabled ? t('plugins.enabled') : t('plugins.disabled')}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-text-muted">{skill.description || skill.path}</p>
                    <div className="mt-2 flex flex-wrap gap-2 text-[9px] text-text-tertiary">
                      {skill.model && <span>{t('extensions.model')}: {skill.model}</span>}
                      {skill.agent && <span>{t('extensions.agent')}: {skill.agent}</span>}
                      {skill.version && <span>v{skill.version}</span>}
                    </div>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" onClick={() => useSkill(skill)} className="rounded-lg bg-accent/10 px-3 py-1.5 text-[10px] font-medium text-accent hover:bg-accent/15">
                    {t('extensions.useSkill')}
                  </button>
                  <button type="button" onClick={() => openSkill(skill)} className="rounded-lg border border-border-subtle px-3 py-1.5 text-[10px] text-text-muted hover:bg-bg-tertiary hover:text-text-primary">
                    {t('extensions.openSource')}
                  </button>
                  <button type="button" onClick={() => void toggleEnabled(skill)} className="rounded-lg border border-border-subtle px-3 py-1.5 text-[10px] text-text-muted hover:bg-bg-tertiary hover:text-text-primary">
                    {enabled ? t('plugins.disable') : t('plugins.enable')}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ExtensionCenter() {
  const t = useT();
  const [section, setSection] = useState<ExtensionSection>('plugins');
  const setMainView = useSettingsStore((state) => state.setMainView);

  useEffect(() => {
    const selectSection = (event: Event) => {
      const requested = (event as CustomEvent<{ section?: ExtensionSection }>).detail?.section;
      if (requested && SECTIONS.some((item) => item.id === requested)) setSection(requested);
    };
    window.addEventListener('blackbox:extension-section', selectSection);
    return () => window.removeEventListener('blackbox:extension-section', selectSection);
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="extension-center">
      <header className="flex-shrink-0 border-b border-border-subtle px-8 pb-4 pt-10">
        <div className="mx-auto flex max-w-6xl items-start justify-between gap-6">
          <div>
            <h1 className="text-[24px] font-semibold tracking-tight text-text-primary">{t('extensions.title')}</h1>
            <p className="mt-1.5 max-w-2xl text-[12px] leading-5 text-text-muted">{t('extensions.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={() => setMainView('chat')}
            title={t('extensions.close')}
            data-testid="extension-center-close"
            className="rounded-lg p-2 text-text-tertiary transition-smooth hover:bg-bg-secondary hover:text-text-primary"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m4 4 8 8M12 4l-8 8" /></svg>
          </button>
        </div>

        <nav className="mx-auto mt-5 flex max-w-6xl gap-1" aria-label={t('extensions.title')}>
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              data-testid={`extension-tab-${item.id}`}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] font-medium transition-smooth ${section === item.id
                ? 'bg-accent/10 text-accent'
                : 'text-text-muted hover:bg-bg-secondary hover:text-text-primary'}`}
            >
              <ExtensionGlyph kind={item.id} size={14} />
              {t(item.labelKey)}
            </button>
          ))}
        </nav>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-6xl">
          {section === 'plugins' && <PluginsTab standalone />}
          {section === 'skills' && <SkillsCatalog />}
          {section === 'workflows' && <WorkflowCatalog />}
          {section === 'mcp' && <McpTab />}
          {section === 'agents' && <AgentCatalog />}
          {section === 'hooks' && <HookCatalog />}
        </div>
      </main>
    </div>
  );
}

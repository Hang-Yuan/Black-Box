import { useEffect, useMemo, useState } from 'react';
import { bridge, type AgentDefinitionInfo } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';
import { useFileStore } from '../../stores/fileStore';
import { useSettingsStore } from '../../stores/settingsStore';

export function AgentCatalog() {
  const t = useT();
  const workingDirectory = useSettingsStore((state) => state.workingDirectory);
  const setMainView = useSettingsStore((state) => state.setMainView);
  const [agents, setAgents] = useState<AgentDefinitionInfo[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      setAgents(await bridge.listAgentDefinitions(workingDirectory || undefined));
      setError('');
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [workingDirectory]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return agents.filter((agent) => !normalized || [
      agent.name,
      agent.description,
      agent.scope,
      agent.model || '',
      ...agent.tools,
      ...agent.skills,
    ].some((value) => value.toLowerCase().includes(normalized)));
  }, [agents, query]);

  const openSource = (agent: AgentDefinitionInfo) => {
    useFileStore.getState().selectFile(agent.path);
    setMainView('chat');
    useSettingsStore.getState().setSecondaryTab('files');
  };

  return (
    <div className="space-y-5" data-testid="extension-agents-catalog">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[260px] flex-1">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary">
            <circle cx="7" cy="7" r="5" /><path d="m11 11 3 3" />
          </svg>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('extensions.searchAgents')}
            className="w-full rounded-xl border border-border-subtle bg-bg-secondary/45 py-2.5 pl-9 pr-3 text-[12px] text-text-primary outline-none transition-smooth placeholder:text-text-tertiary focus:border-accent/60 focus:bg-bg-secondary"
          />
        </div>
        <button type="button" onClick={() => void load()} disabled={loading}
          className="rounded-lg border border-border-subtle px-3 py-2 text-[11px] text-text-muted transition-smooth hover:bg-bg-secondary hover:text-text-primary disabled:opacity-50">
          {loading ? t('plugins.loading') : t('plugins.refresh')}
        </button>
      </div>

      {error && <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-[11px] text-red-500">{error}</div>}
      {loading && agents.length === 0 ? (
        <div className="flex justify-center py-16"><div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/25 border-t-accent" /></div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border-subtle py-16 text-center text-[12px] text-text-tertiary">
          {query ? t('extensions.noAgentMatches') : t('extensions.noAgents')}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {filtered.map((agent) => (
            <article key={agent.path} className="rounded-2xl border border-border-subtle bg-bg-secondary/35 p-4 transition-smooth hover:border-accent/25 hover:bg-bg-secondary/55">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <svg width="19" height="19" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round">
                    <circle cx="9" cy="5.2" r="2.5" /><circle cx="4" cy="8.2" r="1.8" /><circle cx="14" cy="8.2" r="1.8" />
                    <path d="M4.7 15c.5-2.4 2-3.7 4.3-3.7s3.8 1.3 4.3 3.7M1.7 14c.2-1.8 1.1-2.8 2.8-3M16.3 14c-.2-1.8-1.1-2.8-2.8-3" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-[13px] font-semibold text-text-primary">{agent.name}</h3>
                    <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[9px] uppercase text-text-tertiary">{agent.scope}</span>
                    {agent.model && <span className="text-[9px] text-accent">{agent.model}</span>}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-text-muted">{agent.description}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {agent.isolation && <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[9px] text-text-tertiary">isolation: {agent.isolation}</span>}
                    {agent.tools.slice(0, 5).map((tool) => <span key={tool} className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[9px] text-text-tertiary">{tool}</span>)}
                    {agent.skills.slice(0, 3).map((skill) => <span key={`skill-${skill}`} className="rounded bg-accent/10 px-1.5 py-0.5 text-[9px] text-accent">/{skill}</span>)}
                  </div>
                </div>
              </div>
              <div className="mt-4">
                <button type="button" onClick={() => openSource(agent)}
                  className="rounded-lg border border-border-subtle px-3 py-1.5 text-[10px] text-text-muted hover:bg-bg-tertiary hover:text-text-primary">
                  {t('extensions.openSource')}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

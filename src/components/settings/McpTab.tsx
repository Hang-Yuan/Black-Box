import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  mcpServerKey,
  useMcpStore,
  type McpConnectionStatus,
  type McpScope,
  type McpServer,
  type McpServerConfig,
} from '../../stores/mcpStore';
import type { McpTransport } from '../../lib/tauri-bridge';
import { useSettingsStore } from '../../stores/settingsStore';
import { useT } from '../../lib/i18n';

const STATUS_CLASS: Record<McpConnectionStatus, string> = {
  connected: 'bg-green-500',
  failed: 'bg-red-500',
  pendingApproval: 'bg-amber-500',
  rejected: 'bg-red-500',
  needsAuth: 'bg-amber-500',
  unknown: 'bg-text-tertiary',
};

function isRemote(config: McpServerConfig): boolean {
  return Boolean(config.url) || ['http', 'streamable-http', 'sse', 'ws'].includes(config.type || '');
}

function mapToText(values: Record<string, string> | undefined): string {
  return Object.entries(values || {}).map(([key, value]) => `${key}=${value}`).join('\n');
}

function parseMap(text: string, label: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) throw new Error(`${label}: ${trimmed}`);
    result[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1);
  }
  return result;
}

export function McpTab() {
  const t = useT();
  const workingDirectory = useSettingsStore((state) => state.workingDirectory);
  const servers = useMcpStore((state) => state.servers);
  const isLoading = useMcpStore((state) => state.isLoading);
  const isChecking = useMcpStore((state) => state.isChecking);
  const editingServer = useMcpStore((state) => state.editingServer);
  const authenticatingServer = useMcpStore((state) => state.authenticatingServer);
  const isAdding = useMcpStore((state) => state.isAdding);
  const error = useMcpStore((state) => state.error);
  const fetchServers = useMcpStore((state) => state.fetchServers);
  const addServer = useMcpStore((state) => state.addServer);
  const updateServer = useMcpStore((state) => state.updateServer);
  const deleteServer = useMcpStore((state) => state.deleteServer);
  const setProjectApproval = useMcpStore((state) => state.setProjectApproval);
  const loginServer = useMcpStore((state) => state.loginServer);
  const logoutServer = useMcpStore((state) => state.logoutServer);
  const setEditing = useMcpStore((state) => state.setEditing);
  const setAdding = useMcpStore((state) => state.setAdding);
  const clearError = useMcpStore((state) => state.clearError);
  const cwd = workingDirectory || undefined;

  useEffect(() => {
    void fetchServers(cwd, false);
  }, [cwd, fetchServers]);

  const handleDelete = useCallback(async (server: McpServer) => {
    if (!confirm(`${t('mcp.confirmDelete')}\n${server.name} · ${server.scope}`)) return;
    await deleteServer(server, cwd);
  }, [cwd, deleteServer, t]);

  const handleApproval = useCallback(async (server: McpServer, approved: boolean) => {
    if (!cwd) return;
    const prompt = approved ? t('mcp.confirmApprove') : t('mcp.confirmReject');
    if (!confirm(`${prompt}\n${server.name}`)) return;
    await setProjectApproval(server.name, approved, cwd);
  }, [cwd, setProjectApproval, t]);

  const handleLogout = useCallback(async (server: McpServer) => {
    if (!confirm(`${t('mcp.confirmLogout')}\n${server.name}`)) return;
    await logoutServer(server.name, cwd);
  }, [cwd, logoutServer, t]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-medium text-text-primary">{t('mcp.title')}</h3>
          <span className="text-xs text-text-tertiary">{servers.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void fetchServers(cwd, true)}
            disabled={isChecking}
            className="p-1.5 rounded hover:bg-bg-secondary text-text-tertiary disabled:opacity-40 transition-smooth"
            title={t('mcp.healthCheck')}
          >
            <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"
              className={isChecking ? 'animate-spin' : ''}>
              <path d="M1 6a5 5 0 019-2M11 6a5 5 0 01-9 2" />
              <path d="M10 1v3h-3M2 11V8h3" />
            </svg>
          </button>
          <button
            onClick={() => setAdding(true)}
            className="p-1.5 rounded hover:bg-bg-secondary text-text-tertiary transition-smooth"
            title={t('mcp.add')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
        </div>
      </div>

      {!cwd && (
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-[11px] leading-4 text-amber-500">
          {t('mcp.projectScopeNeedsCwd')}
        </p>
      )}

      {error && (
        <button
          onClick={clearError}
          className="w-full rounded-md bg-red-500/10 px-3 py-2 text-left text-[11px] leading-4 text-red-500"
          title={t('mcp.dismissError')}
        >
          {error}
        </button>
      )}

      {isAdding && (
        <McpServerForm
          cwd={cwd}
          onSave={async (name, scope, config) => addServer(name, scope, config, cwd)}
          onCancel={() => setAdding(false)}
          t={t}
        />
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-6">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
        </div>
      ) : servers.length === 0 && !isAdding ? (
        <p className="py-6 text-center text-[13px] text-text-tertiary">{t('mcp.noServers')}</p>
      ) : (
        <div className="space-y-2">
          {servers.map((server) => (
            editingServer === mcpServerKey(server) ? (
              <McpServerForm
                key={mcpServerKey(server)}
                server={server}
                cwd={cwd}
                onSave={async (name, scope, config) => updateServer(server, name, scope, config, cwd)}
                onCancel={() => setEditing(null)}
                t={t}
              />
            ) : (
              <McpServerCard
                key={mcpServerKey(server)}
                server={server}
                authBusy={authenticatingServer === `auth:${server.name}`}
                cwd={cwd}
                onEdit={() => setEditing(mcpServerKey(server))}
                onDelete={() => void handleDelete(server).catch(() => {})}
                onApprove={(approved) => void handleApproval(server, approved).catch(() => {})}
                onLogin={() => void loginServer(server.name, cwd).catch(() => {})}
                onLogout={() => void handleLogout(server).catch(() => {})}
                t={t}
              />
            )
          ))}
        </div>
      )}
    </div>
  );
}

function McpServerCard({
  server,
  authBusy,
  cwd,
  onEdit,
  onDelete,
  onApprove,
  onLogin,
  onLogout,
  t,
}: {
  server: McpServer;
  authBusy: boolean;
  cwd?: string;
  onEdit: () => void;
  onDelete: () => void;
  onApprove: (approved: boolean) => void;
  onLogin: () => void;
  onLogout: () => void;
  t: (key: string) => string;
}) {
  const config = server.config;
  const display = isRemote(config)
    ? config.url || '—'
    : [config.command || '', ...(config.args || [])].filter(Boolean).join(' ');
  const envCount = Object.keys(config.env || {}).length;
  const headerCount = Object.keys(config.headers || {}).length;
  const canAuth = server.effective
    && ['http', 'streamable-http', 'sse'].includes(config.type || '')
    && !['pendingApproval', 'rejected'].includes(server.status);

  return (
    <div className={`group rounded-md border px-4 py-3 transition-smooth ${server.effective
      ? 'border-border-subtle hover:bg-bg-secondary'
      : 'border-border-subtle/60 opacity-65'}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 flex-shrink-0 rounded-full ${STATUS_CLASS[server.status]}`} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">{server.name}</span>
        <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[9px] uppercase text-text-muted">
          {config.type === 'streamable-http' ? 'http' : config.type || 'invalid'}
        </span>
        <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[9px] text-accent">
          {t(`mcp.scope.${server.scope}`)}
        </span>
        <button onClick={onEdit} className="p-1 text-text-tertiary opacity-0 transition-smooth hover:text-text-primary group-hover:opacity-100" title={t('mcp.edit')}>
          <span aria-hidden>✎</span>
        </button>
        <button onClick={onDelete} className="p-1 text-text-tertiary opacity-0 transition-smooth hover:text-red-500 group-hover:opacity-100" title={t('mcp.delete')}>
          <span aria-hidden>×</span>
        </button>
      </div>

      <p className="mt-1 truncate pl-4 font-mono text-[10px] text-text-muted" title={display}>{display || '—'}</p>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-4 text-[10px] text-text-tertiary">
        <span>{t(`mcp.status.${server.status}`)}</span>
        {server.toolCount !== null && <span>{server.toolCount} {t('mcp.tools')}</span>}
        {envCount > 0 && <span>{envCount} {t('mcp.envCount')}</span>}
        {headerCount > 0 && <span>{headerCount} {t('mcp.headerCount')}</span>}
        {server.shadowedBy && <span>{t('mcp.shadowedBy')} {t(`mcp.scope.${server.shadowedBy}`)}</span>}
        {config.alwaysLoad && <span>{t('mcp.alwaysLoad')}</span>}
      </div>

      {server.statusDetail && (
        <p className="mt-1 truncate pl-4 text-[10px] text-text-tertiary" title={server.statusDetail}>{server.statusDetail}</p>
      )}

      {server.scope === 'project' && server.effective && server.status === 'pendingApproval' && cwd && (
        <div className="mt-2 flex gap-2 pl-4">
          <button onClick={() => onApprove(true)} className="rounded bg-amber-500/15 px-2 py-1 text-[10px] text-amber-500 hover:bg-amber-500/20">
            {t('mcp.approve')}
          </button>
          <button onClick={() => onApprove(false)} className="rounded px-2 py-1 text-[10px] text-text-tertiary hover:bg-bg-tertiary">
            {t('mcp.reject')}
          </button>
        </div>
      )}

      {canAuth && (
        <div className="mt-2 flex gap-2 pl-4">
          {server.status === 'connected' ? (
            <button onClick={onLogout} disabled={authBusy} className="text-[10px] text-text-tertiary hover:text-text-primary disabled:opacity-40">
              {authBusy ? t('mcp.authInProgress') : t('mcp.logout')}
            </button>
          ) : (
            <button onClick={onLogin} disabled={authBusy} className="text-[10px] text-accent hover:opacity-80 disabled:opacity-40">
              {authBusy ? t('mcp.authInProgress') : t('mcp.login')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function McpServerForm({
  server,
  cwd,
  onSave,
  onCancel,
  t,
}: {
  server?: McpServer;
  cwd?: string;
  onSave: (name: string, scope: McpScope, config: McpServerConfig) => Promise<void>;
  onCancel: () => void;
  t: (key: string) => string;
}) {
  const initialTransport: McpTransport = server?.config.type === 'streamable-http'
    ? 'http'
    : server?.config.type || (server?.config.url ? 'http' : 'stdio');
  const [name, setName] = useState(server?.name || '');
  const [scope, setScope] = useState<McpScope>(server?.scope || (cwd ? 'local' : 'user'));
  const [transport, setTransport] = useState<McpTransport>(initialTransport);
  const [command, setCommand] = useState(server?.config.command || '');
  const [argsText, setArgsText] = useState((server?.config.args || []).join('\n'));
  const [envText, setEnvText] = useState(mapToText(server?.config.env));
  const [url, setUrl] = useState(server?.config.url || '');
  const [headersText, setHeadersText] = useState(mapToText(server?.config.headers));
  const [headersHelper, setHeadersHelper] = useState(server?.config.headersHelper || '');
  const [oauthEnabled, setOauthEnabled] = useState(Boolean(server?.config.oauth));
  const [clientId, setClientId] = useState(server?.config.oauth?.clientId || '');
  const [callbackPort, setCallbackPort] = useState(server?.config.oauth?.callbackPort?.toString() || '');
  const [oauthScopes, setOauthScopes] = useState(server?.config.oauth?.scopes || '');
  const [metadataUrl, setMetadataUrl] = useState(server?.config.oauth?.authServerMetadataUrl || '');
  const [timeout, setTimeoutValue] = useState(server?.config.timeout?.toString() || '');
  const [alwaysLoad, setAlwaysLoad] = useState(Boolean(server?.config.alwaysLoad));
  const [isSaving, setIsSaving] = useState(false);
  const [localError, setLocalError] = useState('');
  const remote = transport !== 'stdio';
  const scopeDisabled = !cwd && scope !== 'user';
  const canSave = Boolean(name.trim() && !scopeDisabled && (remote ? url.trim() : command.trim()));

  const inputClass = 'w-full rounded-md border border-border-subtle bg-bg-chat px-3 py-2 text-[12px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent';

  const config = useMemo(() => {
    try {
      const base: McpServerConfig = { type: transport };
      if (transport === 'stdio') {
        base.command = command.trim();
        const args = argsText.split('\n').map((value) => value.trim()).filter(Boolean);
        if (args.length) base.args = args;
        const env = parseMap(envText, t('mcp.invalidEnv'));
        if (Object.keys(env).length) base.env = env;
      } else {
        base.url = url.trim();
        const headers = parseMap(headersText, t('mcp.invalidHeaders'));
        if (Object.keys(headers).length) base.headers = headers;
        if (headersHelper.trim()) base.headersHelper = headersHelper.trim();
        if (oauthEnabled && transport === 'http') {
          base.oauth = {};
          if (clientId.trim()) base.oauth.clientId = clientId.trim();
          if (callbackPort.trim()) base.oauth.callbackPort = Number(callbackPort);
          if (oauthScopes.trim()) base.oauth.scopes = oauthScopes.trim();
          if (metadataUrl.trim()) base.oauth.authServerMetadataUrl = metadataUrl.trim();
        }
      }
      if (timeout.trim()) base.timeout = Number(timeout);
      if (alwaysLoad) base.alwaysLoad = true;
      return base;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }, [alwaysLoad, argsText, callbackPort, clientId, command, envText, headersHelper, headersText, metadataUrl, oauthEnabled, oauthScopes, t, timeout, transport, url]);

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    if (config instanceof Error) {
      setLocalError(config.message);
      return;
    }
    setIsSaving(true);
    setLocalError('');
    try {
      await onSave(name.trim(), scope, config);
    } catch {
      // The shared store renders the backend error above the form.
    } finally {
      setIsSaving(false);
    }
  }, [canSave, config, name, onSave, scope]);

  return (
    <div className="space-y-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('mcp.name')}>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('mcp.namePlaceholder')} className={inputClass} autoFocus />
        </Field>
        <Field label={t('mcp.scope')}>
          <select value={scope} onChange={(event) => setScope(event.target.value as McpScope)} className={inputClass}>
            <option value="local" disabled={!cwd}>{t('mcp.scope.local')}</option>
            <option value="project" disabled={!cwd}>{t('mcp.scope.project')}</option>
            <option value="user">{t('mcp.scope.user')}</option>
          </select>
        </Field>
      </div>

      <Field label={t('mcp.transport')}>
        <select value={transport} onChange={(event) => {
          setTransport(event.target.value as McpTransport);
          if (event.target.value !== 'http') setOauthEnabled(false);
        }} className={inputClass}>
          <option value="stdio">stdio</option>
          <option value="http">HTTP · Streamable</option>
          <option value="sse">SSE · {t('mcp.deprecated')}</option>
          <option value="ws">WebSocket</option>
        </select>
      </Field>

      {transport === 'stdio' ? (
        <>
          <Field label={t('mcp.command')}>
            <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={t('mcp.commandPlaceholder')} className={inputClass} />
          </Field>
          <Field label={t('mcp.args')}>
            <textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} placeholder={t('mcp.argsHint')} rows={2} className={`${inputClass} resize-none font-mono`} />
          </Field>
          <Field label={t('mcp.env')}>
            <textarea value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder={t('mcp.envHint')} rows={2} className={`${inputClass} resize-none font-mono`} />
          </Field>
        </>
      ) : (
        <>
          <Field label={t('mcp.url')}>
            <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder={transport === 'ws' ? 'wss://example.com/mcp' : 'https://example.com/mcp'} className={inputClass} />
          </Field>
          <Field label={t('mcp.headers')}>
            <textarea value={headersText} onChange={(event) => setHeadersText(event.target.value)} placeholder={t('mcp.headersHint')} rows={2} className={`${inputClass} resize-none font-mono`} />
          </Field>
          <Field label={t('mcp.headersHelper')}>
            <input value={headersHelper} onChange={(event) => setHeadersHelper(event.target.value)} placeholder={t('mcp.headersHelperHint')} className={inputClass} />
          </Field>
          {transport === 'http' && (
            <div className="space-y-2 rounded-md border border-border-subtle p-3">
              <label className="flex items-center gap-2 text-[11px] text-text-muted">
                <input type="checkbox" checked={oauthEnabled} onChange={(event) => setOauthEnabled(event.target.checked)} />
                {t('mcp.oauthConfig')}
              </label>
              {oauthEnabled && (
                <div className="grid grid-cols-2 gap-2">
                  <input value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder={t('mcp.clientId')} className={inputClass} />
                  <input value={callbackPort} onChange={(event) => setCallbackPort(event.target.value)} placeholder={t('mcp.callbackPort')} inputMode="numeric" className={inputClass} />
                  <input value={oauthScopes} onChange={(event) => setOauthScopes(event.target.value)} placeholder={t('mcp.oauthScopes')} className={`${inputClass} col-span-2`} />
                  <input value={metadataUrl} onChange={(event) => setMetadataUrl(event.target.value)} placeholder={t('mcp.metadataUrl')} className={`${inputClass} col-span-2`} />
                  <p className="col-span-2 text-[10px] leading-4 text-text-tertiary">{t('mcp.oauthTokenNote')}</p>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label={t('mcp.timeout')}>
          <input value={timeout} onChange={(event) => setTimeoutValue(event.target.value)} placeholder="600000" inputMode="numeric" className={inputClass} />
        </Field>
        <label className="mt-5 flex items-center gap-2 text-[11px] text-text-muted">
          <input type="checkbox" checked={alwaysLoad} onChange={(event) => setAlwaysLoad(event.target.checked)} />
          {t('mcp.alwaysLoad')}
        </label>
      </div>

      {(localError || scopeDisabled) && (
        <p className="text-[10px] text-red-500">{localError || t('mcp.projectScopeNeedsCwd')}</p>
      )}

      <div className="flex gap-3">
        <button onClick={() => void handleSave()} disabled={!canSave || isSaving} className="flex-1 rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-text-inverse transition-smooth hover:bg-accent-hover disabled:opacity-40">
          {isSaving ? '…' : t('mcp.save')}
        </button>
        <button onClick={onCancel} className="px-4 py-2 text-[13px] text-text-muted transition-smooth hover:text-text-primary">{t('mcp.cancel')}</button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] text-text-muted">{label}</span>
      {children}
    </label>
  );
}

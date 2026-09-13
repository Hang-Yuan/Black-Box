import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { save } from '@tauri-apps/plugin-dialog';
import { bridge } from '../../lib/tauri-bridge';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSessionStore } from '../../stores/sessionStore';
import type { ResponseArtifact } from '../../lib/response-artifacts';

export function ResponseArtifacts({ artifacts }: { artifacts: ResponseArtifact[] }) {
  const zh = useSettingsStore((state) => state.locale) === 'zh';
  const [selected, setSelected] = useState<string | null>(null);
  const [wrap, setWrap] = useState(true);
  const [status, setStatus] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const current = artifacts.find((item) => item.id === selected);
  useEffect(() => {
    if (current) dialog.current?.showModal();
    else dialog.current?.close();
  }, [selected]);
  const download = async () => {
    if (!current) return;
    try {
      const path = await save({ defaultPath: current.name.split('/').pop() });
      if (!path) return;
      const tabId = useSessionStore.getState().selectedSessionId;
      if (!tabId) throw new Error('Select a task before saving');
      await bridge.addPathGrant(tabId, path);
      await bridge.writeFileContent(path, current.content, tabId);
      setStatus(zh ? '已保存' : 'Saved');
    } catch (error) { setStatus(String(error)); }
  };
  return <div className="not-prose my-3 space-y-2" data-response-artifacts>
    {artifacts.map((item) => <button key={item.id} onClick={() => { setSelected(item.id); setStatus(''); }}
      className="block w-full rounded-lg border border-border-subtle bg-bg-secondary p-3 text-left text-accent">
      📄 {item.name} <span className="text-text-muted">· {zh ? '打开文件' : 'Open file'}</span>
    </button>)}
    {createPortal(<dialog ref={dialog} onCancel={() => setSelected(null)} onClose={() => setSelected(null)}
      aria-label="Artifact files" className="fixed inset-0 m-auto h-[85vh] w-[90vw] max-w-6xl rounded-xl border border-border-subtle bg-bg-primary text-text-primary backdrop:bg-black/40">
      {current && <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-3 border-b border-border-subtle p-3">
          <strong className="min-w-0 flex-1 truncate">{current.name}</strong>
          <button onClick={() => setWrap(!wrap)} aria-pressed={wrap}>{zh ? '换行' : 'Wrap'}</button>
          <button onClick={() => { navigator.clipboard.writeText(current.content).then(() => setStatus(zh ? '已复制' : 'Copied')).catch((e) => setStatus(String(e))); }}>{zh ? '复制' : 'Copy'}</button>
          <button onClick={download}>{zh ? '下载' : 'Save'}</button>
          <button onClick={() => setSelected(null)} aria-label="Close artifact">✕</button>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav aria-label="Artifact directory" className="w-52 shrink-0 overflow-auto border-r border-border-subtle p-2">
            {artifacts.map((item) => <button key={item.id} onClick={() => { setSelected(item.id); setStatus(''); }}
              aria-current={item.id === selected ? 'page' : undefined}
              className={`block w-full break-all rounded p-2 text-left text-xs ${item.id === selected ? 'bg-accent/15 text-accent' : ''}`}>{item.name}</button>)}
          </nav>
          <pre className={`min-w-0 flex-1 overflow-auto p-4 text-xs ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}><code>{current.content}</code></pre>
        </div>
        {status && <p role="status" className="border-t border-border-subtle p-2 text-xs">{status}</p>}
      </div>}
    </dialog>, document.body)}
  </div>;
}

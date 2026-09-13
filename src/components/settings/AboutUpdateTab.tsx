import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { useAppUpdateStore, type AppUpdateStatus } from '../../stores/appUpdateStore';
import { useSettingsStore } from '../../stores/settingsStore';

export function AboutUpdateTab() {
  const [version, setVersion] = useState('');
  const update = useAppUpdateStore();
  const zh = useSettingsStore((state) => state.locale) === 'zh';
  useEffect(() => {
    void getVersion().then(setVersion);
    void update.refresh();
    const listener = listen<AppUpdateStatus>('app:update', (event) => useAppUpdateStore.setState({ status: event.payload }));
    return () => { void listener.then((unlisten) => unlisten()); };
  }, []);
  const labels: Record<string, string> = zh ? {
    idle: '检查 Black Box 新版本', available: '发现新版', current: '当前已是最新版本',
    downloading: '正在下载并校验签名', downloaded: '签名校验通过，等待安装',
    installing: '正在安装并重启', installed: '更新完成', interrupted: '上次更新未完成，可重新检查或回滚', error: '更新失败',
  } : {
    idle: 'Check for Black Box updates', available: 'Update available', current: 'Up to date',
    downloading: 'Downloading and verifying signature', downloaded: 'Signature verified; ready to install',
    installing: 'Installing and restarting', installed: 'Update complete', interrupted: 'Update interrupted; check again or roll back', error: 'Update failed',
  };
  const action = 'rounded-md border border-border-subtle px-3 py-2 text-xs hover:bg-bg-secondary disabled:opacity-40';
  return <section className="space-y-5" data-testid="about-update">
    <div><h3 className="text-lg font-semibold">Black Box {version && `v${version}`}</h3>
      <p className="mt-1 text-xs text-text-muted">{zh ? '关于与更新' : 'About & updates'}</p></div>
    <div role="status" className="rounded-lg border border-border-subtle p-4">
      <p className="text-sm">{update.waiting ? (zh ? '等待会话和排程空闲后安装；关闭设置后继续等待' : 'Waiting for conversations and scheduled runs to become idle') : labels[update.status.phase] ?? labels.idle}
        {update.status.version && ` · v${update.status.version}`}</p>
      {update.status.phase === 'downloading' && <div className="mt-3">
        <progress className="w-full" value={update.status.total ? update.status.downloaded : undefined} max={update.status.total ?? 1} />
        <p className="text-xs text-text-muted">{(update.status.downloaded / 1048576).toFixed(1)} MB{update.status.total ? ` / ${(update.status.total / 1048576).toFixed(1)} MB` : ''}</p>
      </div>}
      {update.status.error && <p role="alert" className="mt-2 break-words text-xs text-error">{update.status.error}</p>}
    </div>
    <div className="flex flex-wrap gap-2">
      <button className={action} disabled={update.busy || update.waiting} onClick={() => void update.check()}>{zh ? '检查更新' : 'Check for updates'}</button>
      {update.status.phase === 'available' && <button className={action} disabled={update.busy} onClick={() => void update.download()}>{zh ? '下载新版' : 'Download update'}</button>}
      {update.status.phase === 'downloaded' && !update.waiting && <button className={action} onClick={update.installWhenIdle}>{zh ? '空闲时安装并重启' : 'Install when idle & restart'}</button>}
      {update.waiting && <button className={action} onClick={update.cancelWait}>{zh ? '取消等待' : 'Cancel waiting'}</button>}
      {update.status.previousVersion && <button className={action} disabled={update.busy || update.waiting} onClick={() => void update.check(true)}>{zh ? '回滚到' : 'Roll back to'} v{update.status.previousVersion}</button>}
    </div>
    {update.status.notes && <p className="whitespace-pre-wrap text-xs leading-6 text-text-muted">{update.status.notes}</p>}
    <p className="text-xs leading-6 text-text-tertiary">{zh ? '更新包使用 Black Box 发布签名校验。安装会保留任务与草稿；回滚使用上一版已签名安装包。' : 'Updates are verified with the Black Box release key. Installation preserves tasks and drafts. Rollback uses the previous signed release.'}</p>
  </section>;
}

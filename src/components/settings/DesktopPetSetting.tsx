import { useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { DESKTOP_PET_ENABLED_EVENT, type DesktopPetPhase } from '../../lib/desktop-pet';
import {
  DEFAULT_DESKTOP_PET_APPEARANCE,
  DESKTOP_PET_ACCESSORIES,
  DESKTOP_PET_BODIES,
  DESKTOP_PET_EYES,
  DESKTOP_PET_MOTIONS,
  DESKTOP_PET_MOUTHS,
  DESKTOP_PET_PRESETS,
  DESKTOP_PET_SCALES,
  normalizeDesktopPetAppearance,
  normalizeDesktopPetDesign,
  randomDesktopPetDesign,
  resolveDesktopPetDesign,
  type DesktopPetAppearance,
  type DesktopPetDesign,
} from '../../lib/desktop-pet-presets';
import { bridge, type DesktopPetStatus } from '../../lib/tauri-bridge';
import { useSettingsStore } from '../../stores/settingsStore';
import { PetAvatar } from '../desktop-pet/PetAvatar';

type Bilingual = { zh: string; en: string };

const PHASES: readonly { id: DesktopPetPhase; label: Bilingual }[] = [
  { id: 'idle', label: { zh: '待命', en: 'Idle' } },
  { id: 'thinking', label: { zh: '思考', en: 'Thinking' } },
  { id: 'tool', label: { zh: '工具', en: 'Tool' } },
  { id: 'running', label: { zh: '运行', en: 'Running' } },
  { id: 'waiting', label: { zh: '等待', en: 'Waiting' } },
  { id: 'error', label: { zh: '错误', en: 'Error' } },
];

const BODY_LABELS: Record<string, Bilingual> = {
  hourglass: { zh: '沙漏', en: 'Hourglass' },
  cat: { zh: '猫', en: 'Cat' },
  fox: { zh: '狐狸', en: 'Fox' },
  rabbit: { zh: '兔子', en: 'Rabbit' },
  bear: { zh: '熊', en: 'Bear' },
  owl: { zh: '猫头鹰', en: 'Owl' },
  robot: { zh: '机器人', en: 'Robot' },
  cloud: { zh: '云', en: 'Cloud' },
  slime: { zh: '果冻', en: 'Slime' },
  axolotl: { zh: '六角恐龙', en: 'Axolotl' },
  spirit: { zh: '小精灵', en: 'Spirit' },
};

const EYE_LABELS: Record<string, Bilingual> = {
  dot: { zh: '圆眼', en: 'Dot' },
  sparkle: { zh: '星星眼', en: 'Sparkle' },
  sleepy: { zh: '困困眼', en: 'Sleepy' },
  visor: { zh: '电子屏', en: 'Visor' },
  wink: { zh: '眨眼', en: 'Wink' },
};

const MOUTH_LABELS: Record<string, Bilingual> = {
  smile: { zh: '微笑', en: 'Smile' },
  cat: { zh: '猫猫嘴', en: 'Cat' },
  tiny: { zh: '小圆嘴', en: 'Tiny' },
  flat: { zh: '平静', en: 'Calm' },
  none: { zh: '隐藏', en: 'None' },
};

const ACCESSORY_LABELS: Record<string, Bilingual> = {
  none: { zh: '无', en: 'None' },
  crown: { zh: '王冠', en: 'Crown' },
  bow: { zh: '蝴蝶结', en: 'Bow' },
  leaf: { zh: '叶子', en: 'Leaf' },
  star: { zh: '星星', en: 'Star' },
  glasses: { zh: '眼镜', en: 'Glasses' },
  headset: { zh: '耳机', en: 'Headset' },
  scarf: { zh: '围巾', en: 'Scarf' },
  antenna: { zh: '天线', en: 'Antenna' },
};

const MOTION_LABELS: Record<string, Bilingual> = {
  float: { zh: '漂浮', en: 'Float' },
  bounce: { zh: '弹跳', en: 'Bounce' },
  pulse: { zh: '呼吸', en: 'Pulse' },
  orbit: { zh: '环绕', en: 'Orbit' },
};

const SCALE_LABELS: Record<string, Bilingual> = {
  compact: { zh: '小', en: 'Small' },
  normal: { zh: '中', en: 'Medium' },
  large: { zh: '大', en: 'Large' },
};

function SettingSwitch({
  checked,
  label,
  disabled = false,
  onToggle,
  testId,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onToggle: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={onToggle}
      className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40
        ${checked ? 'bg-accent' : 'bg-bg-tertiary'}`}
    >
      <span
        className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform"
        style={{ transform: `translateX(${checked ? 20 : 0}px)` }}
      />
    </button>
  );
}

function FieldSelect({
  label,
  value,
  options,
  labels,
  locale,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  labels: Record<string, Bilingual>;
  locale: 'zh' | 'en';
  onChange: (value: string) => void;
}) {
  return (
    <label className="space-y-1.5">
      <span className="text-[10px] font-medium text-text-muted">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-lg border border-border-subtle bg-bg-card px-2.5 text-[11px] text-text-primary outline-none transition-colors focus:border-accent/60"
      >
        {options.map((option) => (
          <option key={option} value={option}>{labels[option]?.[locale] || option}</option>
        ))}
      </select>
    </label>
  );
}

export function DesktopPetSetting() {
  const locale = useSettingsStore((state) => state.locale);
  const copy = (zh: string, en: string) => locale === 'zh' ? zh : en;
  const [status, setStatus] = useState<DesktopPetStatus | null>(null);
  const [appearance, setAppearance] = useState<DesktopPetAppearance>(DEFAULT_DESKTOP_PET_APPEARANCE);
  const [customDraft, setCustomDraft] = useState<DesktopPetDesign>(DEFAULT_DESKTOP_PET_APPEARANCE.custom);
  const [previewPhase, setPreviewPhase] = useState<DesktopPetPhase>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const receive = (value: DesktopPetStatus) => {
      const nextAppearance = normalizeDesktopPetAppearance(value.appearance);
      setStatus(value);
      setAppearance(nextAppearance);
      setCustomDraft(nextAppearance.custom);
      setError(null);
    };

    void bridge.getDesktopPetStatus()
      .then((value) => { if (!disposed) receive(value); })
      .catch((reason) => { if (!disposed) setError(String(reason)); });

    void listen<DesktopPetStatus>(DESKTOP_PET_ENABLED_EVENT, (event) => {
      if (!disposed) receive(event.payload);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const activeDesign = useMemo(() => resolveDesktopPetDesign(appearance), [appearance]);
  const enabled = status?.enabled ?? false;
  const supported = status?.supported !== false;

  const updateAppearance = async (next: DesktopPetAppearance) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const value = await bridge.setDesktopPetAppearance(normalizeDesktopPetAppearance(next));
      const normalized = normalizeDesktopPetAppearance(value.appearance);
      setStatus(value);
      setAppearance(normalized);
      setCustomDraft(normalized.custom);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    if (busy || !supported) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await bridge.setDesktopPetEnabled(!enabled));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const patchDraft = <K extends keyof DesktopPetDesign>(key: K, value: DesktopPetDesign[K]) => {
    setCustomDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="space-y-6" data-testid="desktop-pet-settings-page">
      <section className="overflow-hidden rounded-2xl border border-border-subtle bg-bg-secondary/35">
        <div className="flex items-start justify-between gap-5 border-b border-border-subtle px-5 py-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[15px] font-semibold text-text-primary">
                {copy('桌面伙伴', 'Desktop Companion')}
              </h3>
              <span className="rounded-full border border-border-subtle bg-bg-card px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                macOS
              </span>
            </div>
            <p className="mt-1 max-w-[520px] text-[11px] leading-5 text-text-muted">
              {copy(
                '选择一个预设伙伴，或亲手捏出自己的桌宠。它只读取 Black Box 现有任务状态，不会额外启动 Agent 或消耗 token。',
                'Pick a companion or craft your own. It only reflects existing Black Box activity and never starts an Agent or consumes tokens.',
              )}
            </p>
          </div>
          <SettingSwitch
            checked={enabled}
            label={copy('显示桌面伙伴', 'Show desktop companion')}
            testId="desktop-pet-toggle"
            disabled={busy || !status || !supported}
            onToggle={() => { void toggle(); }}
          />
        </div>

        <div className="grid gap-5 p-5 md:grid-cols-[220px_1fr]">
          <div className="relative flex min-h-[230px] items-center justify-center overflow-hidden rounded-2xl border border-border-subtle bg-[radial-gradient(circle_at_50%_40%,rgba(120,160,255,0.13),transparent_65%)]">
            <div className="absolute inset-x-5 bottom-4 h-8 rounded-[50%] bg-black/20 blur-xl" />
            <PetAvatar design={activeDesign} phase={previewPhase} size={170} decorative={false} />
            <span className="absolute bottom-3 rounded-full border border-border-subtle bg-bg-card/85 px-3 py-1 text-[10px] font-medium text-text-muted backdrop-blur">
              {activeDesign.name}
            </span>
          </div>

          <div className="flex min-w-0 flex-col justify-center">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">
              {copy('状态预览', 'State preview')}
            </span>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {PHASES.map((phase) => (
                <button
                  key={phase.id}
                  type="button"
                  onClick={() => setPreviewPhase(phase.id)}
                  className={`rounded-lg border px-2 py-2 text-[10px] font-medium transition-colors
                    ${previewPhase === phase.id
                      ? 'border-accent/50 bg-accent/10 text-accent'
                      : 'border-border-subtle bg-bg-card/60 text-text-muted hover:bg-bg-card'}`}
                >
                  {phase.label[locale]}
                </button>
              ))}
            </div>
            <div className="mt-4 rounded-xl border border-border-subtle bg-bg-card/55 p-3 text-[10px] leading-5 text-text-tertiary">
              {copy(
                '待命、思考、工具执行、运行、等待回复和错误会自动切换表情光效。关闭桌宠不会退出 Black Box。',
                'Idle, thinking, tool, running, waiting and error states automatically change its motion and status glow. Closing the companion keeps Black Box running.',
              )}
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            <h3 className="text-[13px] font-semibold text-text-primary">
              {copy('预设伙伴', 'Preset companions')}
            </h3>
            <p className="mt-1 text-[10px] text-text-tertiary">
              {copy('20 个内置伙伴，点击立即应用。', '20 built-in companions. Click one to apply it immediately.')}
            </p>
          </div>
          <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-[10px] font-semibold text-text-muted">
            {DESKTOP_PET_PRESETS.length}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2.5 lg:grid-cols-4" data-testid="desktop-pet-preset-grid">
          {DESKTOP_PET_PRESETS.map((preset) => {
            const selected = appearance.presetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                disabled={busy}
                data-preset-id={preset.id}
                onClick={() => { void updateAppearance({ ...appearance, presetId: preset.id }); }}
                className={`group relative flex min-h-[112px] flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-3 transition-all disabled:opacity-50
                  ${selected
                    ? 'border-accent/55 bg-accent/[0.08] ring-1 ring-accent/20'
                    : 'border-border-subtle bg-bg-secondary/35 hover:-translate-y-0.5 hover:border-accent/30 hover:bg-bg-card'}`}
              >
                <PetAvatar design={preset.design} phase="idle" size={66} animated={false} />
                <span className={`max-w-full truncate text-[10px] font-medium ${selected ? 'text-accent' : 'text-text-muted group-hover:text-text-primary'}`}>
                  {preset.name[locale]}
                </span>
                {selected && <span className="absolute right-2 top-2 text-[10px] text-accent">✓</span>}
              </button>
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-border-subtle bg-bg-secondary/35 p-5" data-testid="desktop-pet-maker">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-[13px] font-semibold text-text-primary">
              {copy('捏宠工坊', 'Companion maker')}
            </h3>
            <p className="mt-1 text-[10px] leading-4 text-text-tertiary">
              {copy('组合身体、五官、配饰、颜色与动作，保存为“我的伙伴”。', 'Combine a body, face, accessory, colors and motion, then save it as My Companion.')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCustomDraft(randomDesktopPetDesign())}
            className="rounded-lg border border-border-subtle bg-bg-card px-3 py-1.5 text-[10px] font-medium text-text-muted transition-colors hover:border-accent/35 hover:text-text-primary"
          >
            {copy('随机捏一个', 'Surprise me')}
          </button>
        </div>

        <div className="mt-4 grid gap-5 lg:grid-cols-[210px_1fr]">
          <div className="flex min-h-[230px] flex-col items-center justify-center rounded-2xl border border-border-subtle bg-bg-card/55 p-4">
            <PetAvatar design={customDraft} phase={previewPhase} size={165} decorative={false} />
            <span className="mt-1 max-w-full truncate text-[11px] font-semibold text-text-primary">{customDraft.name}</span>
            <span className="mt-1 text-[9px] text-text-tertiary">{copy('实时预览', 'Live preview')}</span>
          </div>

          <div className="grid content-start grid-cols-2 gap-3">
            <label className="col-span-2 space-y-1.5">
              <span className="text-[10px] font-medium text-text-muted">{copy('名字', 'Name')}</span>
              <input
                value={customDraft.name}
                maxLength={16}
                onChange={(event) => patchDraft('name', event.target.value)}
                className="h-9 w-full rounded-lg border border-border-subtle bg-bg-card px-3 text-[11px] text-text-primary outline-none transition-colors focus:border-accent/60"
                placeholder={copy('我的伙伴', 'My companion')}
              />
            </label>

            <FieldSelect label={copy('身体', 'Body')} value={customDraft.body} options={DESKTOP_PET_BODIES} labels={BODY_LABELS} locale={locale} onChange={(value) => patchDraft('body', value as DesktopPetDesign['body'])} />
            <FieldSelect label={copy('眼睛', 'Eyes')} value={customDraft.eyes} options={DESKTOP_PET_EYES} labels={EYE_LABELS} locale={locale} onChange={(value) => patchDraft('eyes', value as DesktopPetDesign['eyes'])} />
            <FieldSelect label={copy('嘴巴', 'Mouth')} value={customDraft.mouth} options={DESKTOP_PET_MOUTHS} labels={MOUTH_LABELS} locale={locale} onChange={(value) => patchDraft('mouth', value as DesktopPetDesign['mouth'])} />
            <FieldSelect label={copy('配饰', 'Accessory')} value={customDraft.accessory} options={DESKTOP_PET_ACCESSORIES} labels={ACCESSORY_LABELS} locale={locale} onChange={(value) => patchDraft('accessory', value as DesktopPetDesign['accessory'])} />
            <FieldSelect label={copy('动作', 'Motion')} value={customDraft.motion} options={DESKTOP_PET_MOTIONS} labels={MOTION_LABELS} locale={locale} onChange={(value) => patchDraft('motion', value as DesktopPetDesign['motion'])} />

            <div className="space-y-1.5">
              <span className="text-[10px] font-medium text-text-muted">{copy('尺寸', 'Size')}</span>
              <div className="grid h-9 grid-cols-3 overflow-hidden rounded-lg border border-border-subtle bg-bg-card">
                {DESKTOP_PET_SCALES.map((scale) => (
                  <button
                    key={scale}
                    type="button"
                    onClick={() => patchDraft('scale', scale)}
                    className={`border-r border-border-subtle text-[10px] font-medium last:border-r-0 ${customDraft.scale === scale ? 'bg-accent/10 text-accent' : 'text-text-muted hover:bg-bg-secondary'}`}
                  >
                    {SCALE_LABELS[scale][locale]}
                  </button>
                ))}
              </div>
            </div>

            <label className="space-y-1.5">
              <span className="text-[10px] font-medium text-text-muted">{copy('身体颜色', 'Body color')}</span>
              <span className="flex h-9 items-center gap-2 rounded-lg border border-border-subtle bg-bg-card px-2">
                <input type="color" value={customDraft.bodyColor} onChange={(event) => patchDraft('bodyColor', event.target.value)} className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent p-0" />
                <span className="font-mono text-[10px] text-text-tertiary">{customDraft.bodyColor}</span>
              </span>
            </label>

            <label className="space-y-1.5">
              <span className="text-[10px] font-medium text-text-muted">{copy('高光颜色', 'Accent color')}</span>
              <span className="flex h-9 items-center gap-2 rounded-lg border border-border-subtle bg-bg-card px-2">
                <input type="color" value={customDraft.accentColor} onChange={(event) => patchDraft('accentColor', event.target.value)} className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent p-0" />
                <span className="font-mono text-[10px] text-text-tertiary">{customDraft.accentColor}</span>
              </span>
            </label>

            <div className="col-span-2 flex items-center justify-between gap-4 rounded-xl border border-border-subtle bg-bg-card/60 px-3 py-2.5">
              <div>
                <div className="text-[11px] font-medium text-text-primary">{copy('显示状态文字', 'Show status caption')}</div>
                <p className="mt-0.5 text-[9px] text-text-tertiary">{copy('关闭后只保留桌宠与状态光点。', 'Hide the caption and keep only the companion and status glow.')}</p>
              </div>
              <SettingSwitch
                checked={customDraft.showCaption}
                label={copy('显示状态文字', 'Show status caption')}
                onToggle={() => patchDraft('showCaption', !customDraft.showCaption)}
              />
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
          <span className="text-[9px] text-text-tertiary">
            {appearance.presetId === 'custom'
              ? copy('当前正在使用“我的伙伴”。', 'My Companion is currently active.')
              : copy('保存后会切换到“我的伙伴”。', 'Saving switches to My Companion.')}
          </span>
          <button
            type="button"
            data-testid="desktop-pet-apply-custom"
            disabled={busy}
            onClick={() => { void updateAppearance({ presetId: 'custom', custom: normalizeDesktopPetDesign(customDraft) }); }}
            className="rounded-lg bg-accent px-4 py-2 text-[11px] font-semibold text-text-inverse shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? copy('正在保存…', 'Saving…') : copy('应用我的桌宠', 'Apply My Companion')}
          </button>
        </div>
      </section>

      {error && (
        <p className="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[10px] leading-4 text-red-400" role="alert">
          {copy('无法更新桌宠：', 'Could not update the companion:')} {error}
        </p>
      )}
    </div>
  );
}

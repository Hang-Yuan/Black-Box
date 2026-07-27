import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { bridge, type DesktopPetStatus } from '../../lib/tauri-bridge';
import {
  DEFAULT_DESKTOP_PET_STATE,
  DESKTOP_PET_ENABLED_EVENT,
  DESKTOP_PET_STATE_EVENT,
  DESKTOP_PET_STATE_REQUEST_EVENT,
  type DesktopPetPhase,
  type DesktopPetState,
} from '../../lib/desktop-pet';
import {
  DEFAULT_DESKTOP_PET_APPEARANCE,
  normalizeDesktopPetAppearance,
  resolveDesktopPetDesign,
  type DesktopPetAppearance,
} from '../../lib/desktop-pet-presets';
import { PetAvatar } from './PetAvatar';
import './DesktopPet.css';

const PHASE_COPY: Record<DesktopPetPhase, string> = {
  idle: '待命',
  thinking: '思考中',
  tool: '调用工具',
  running: '执行中',
  waiting: '等你回应',
  error: '需要查看',
};

interface DragOrigin {
  x: number;
  y: number;
  dragging: boolean;
}

export function DesktopPet() {
  const [state, setState] = useState<DesktopPetState>(DEFAULT_DESKTOP_PET_STATE);
  const [appearance, setAppearance] = useState<DesktopPetAppearance>(DEFAULT_DESKTOP_PET_APPEARANCE);
  const dragOrigin = useRef<DragOrigin | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('desktop-pet-document');
    document.body.classList.add('desktop-pet-document');
    let disposed = false;
    let unlistenState: (() => void) | undefined;
    let unlistenConfig: (() => void) | undefined;
    let retry: number | undefined;

    void bridge.getDesktopPetStatus().then((status) => {
      if (!disposed) setAppearance(normalizeDesktopPetAppearance(status.appearance));
    }).catch(() => {
      // A missing config is equivalent to the built-in hourglass preset.
    });

    void listen<DesktopPetState>(DESKTOP_PET_STATE_EVENT, (event) => {
      setState(event.payload);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else {
        unlistenState = cleanup;
        void emit(DESKTOP_PET_STATE_REQUEST_EVENT);
        retry = window.setTimeout(() => {
          void emit(DESKTOP_PET_STATE_REQUEST_EVENT);
        }, 250);
      }
    });

    void listen<DesktopPetStatus>(DESKTOP_PET_ENABLED_EVENT, (event) => {
      setAppearance(normalizeDesktopPetAppearance(event.payload.appearance));
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlistenConfig = cleanup;
    });

    return () => {
      disposed = true;
      if (retry !== undefined) window.clearTimeout(retry);
      unlistenState?.();
      unlistenConfig?.();
      document.documentElement.classList.remove('desktop-pet-document');
      document.body.classList.remove('desktop-pet-document');
    };
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    dragOrigin.current = { x: event.screenX, y: event.screenY, dragging: false };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = dragOrigin.current;
    if (!origin || origin.dragging) return;
    if (Math.hypot(event.screenX - origin.x, event.screenY - origin.y) < 5) return;
    origin.dragging = true;
    void getCurrentWindow().startDragging().finally(() => {
      dragOrigin.current = null;
    });
  };

  const handlePointerUp = () => {
    const origin = dragOrigin.current;
    dragOrigin.current = null;
    if (origin && !origin.dragging) {
      void bridge.focusMainWindow();
    }
  };

  const detail = state.detail?.trim();
  const design = resolveDesktopPetDesign(appearance);

  return (
    <div
      className={`desktop-pet desktop-pet--${state.phase}`}
      data-testid="desktop-pet"
      data-phase={state.phase}
      data-preset={appearance.presetId}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => { dragOrigin.current = null; }}
      title={`${design.name} · 拖动桌宠；单击打开 Black Box`}
    >
      <button
        type="button"
        className="desktop-pet__close"
        aria-label="关闭桌宠"
        title="关闭桌宠"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          void bridge.setDesktopPetEnabled(false);
        }}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 3l6 6M9 3L3 9" />
        </svg>
      </button>

      <div className="desktop-pet__halo" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="desktop-pet__body">
        <div className="desktop-pet__glass">
          <PetAvatar
            className="desktop-pet__avatar"
            design={design}
            phase={state.phase}
            size={112}
          />
        </div>
      </div>
      {design.showCaption && (
        <div className="desktop-pet__caption" aria-live="polite">
          <span>{PHASE_COPY[state.phase]}</span>
          {detail && <small title={detail}>{detail}</small>}
        </div>
      )}
    </div>
  );
}

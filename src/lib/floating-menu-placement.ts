export interface FloatingMenuSize {
  width: number;
  height: number;
}

export interface FloatingMenuViewport {
  width: number;
  height: number;
  margin?: number;
}

export interface FloatingMenuPosition {
  left: number;
  top: number;
  horizontal: 'left' | 'right';
  vertical: 'up' | 'down';
}

export interface FloatingMenuAnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const DEFAULT_MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Place a context menu at the pointer while keeping the whole menu visible.
 * Near the lower edge the same item order is retained and the menu is moved
 * upward so its bottom edge stays inside the viewport.
 */
export function placeContextMenu(
  x: number,
  y: number,
  size: FloatingMenuSize,
  viewport: FloatingMenuViewport,
): FloatingMenuPosition {
  const margin = viewport.margin ?? DEFAULT_MARGIN;
  const maxLeft = viewport.width - size.width - margin;
  const opensDown = y + size.height <= viewport.height - margin;

  return {
    left: clamp(x, margin, maxLeft),
    top: opensDown
      ? clamp(y, margin, viewport.height - size.height - margin)
      : clamp(y - size.height, margin, viewport.height - size.height - margin),
    horizontal: 'right',
    vertical: opensDown ? 'down' : 'up',
  };
}

/**
 * Place a submenu beside its trigger. It opens right by default, flips left
 * when needed, and bottom-aligns with a low trigger so the list grows upward
 * without reversing its DOM or visual order.
 */
export function placeSubmenu(
  anchor: FloatingMenuAnchorRect,
  size: FloatingMenuSize,
  viewport: FloatingMenuViewport,
  gap = 4,
): FloatingMenuPosition {
  const margin = viewport.margin ?? DEFAULT_MARGIN;
  const opensRight = anchor.right + gap + size.width <= viewport.width - margin;
  const opensDown = anchor.top + size.height <= viewport.height - margin;

  return {
    left: opensRight
      ? clamp(anchor.right + gap, margin, viewport.width - size.width - margin)
      : clamp(anchor.left - gap - size.width, margin, viewport.width - size.width - margin),
    top: opensDown
      ? clamp(anchor.top, margin, viewport.height - size.height - margin)
      : clamp(anchor.bottom - size.height, margin, viewport.height - size.height - margin),
    horizontal: opensRight ? 'right' : 'left',
    vertical: opensDown ? 'down' : 'up',
  };
}

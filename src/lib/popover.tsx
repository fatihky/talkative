/*
 * Popover / Tip / Menu — the app's floating surfaces: anchored panels,
 * hover tooltips, and dropdown menus.
 *
 * Business logic:
 * - Popover portals into document.body and positions from the anchor's
 *   rect, so it escapes the overflow and stacking contexts of the sidebar,
 *   composer and right panel that open it.
 * - It keeps an 8px gap, opens upward by default, flips below the anchor
 *   when the top would run off screen, and clamps into the viewport; it
 *   re-measures on window resize and whenever its own content resizes.
 * - Until the first measurement lands it stays visibility:hidden rather
 *   than painting at the placeholder offset, so it never flashes.
 * - Dismissal carries intent: an outside press closes with restoreFocus
 *   false, esc closes with true so the caller returns focus to the trigger
 *   and the event is swallowed before an outer esc handler can also fire.
 * - Tip only exists on hover-capable devices: on touch it renders its child
 *   bare, since hover tooltips stuck open after a tap; while shown, any
 *   pointerdown or scroll hides it.
 * - Menu layers keyboard selection on Popover: arrows skip separators and
 *   wrap, enter runs the item and restores focus, a mouse click runs it
 *   without stealing focus back, and hover merely tracks the highlight.
 */
'use client';

import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

type Placement = 'top-start' | 'bottom-start' | 'bottom-end';

/**
 * Anchored popover rendered in a portal. Opens upward by default
 * (`placement="top-start"`), 8px offset, flips down when there is no room.
 * Closes on click-outside and Esc; Esc restores focus to the trigger.
 */
export function Popover({
  open,
  anchor,
  onClose,
  placement = 'top-start',
  width,
  z = 40,
  matchAnchorWidth = false,
  children,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  onClose: (restoreFocus: boolean) => void;
  placement?: Placement;
  width?: number | undefined;
  z?: number;
  matchAnchorWidth?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const measure = () => {
      const a = anchor.current?.getBoundingClientRect();
      const p = ref.current?.getBoundingClientRect();
      if (!a || !p) return;
      let top = placement === 'top-start' ? a.top - p.height - 8 : a.bottom + 8;
      let left = placement === 'bottom-end' ? a.right - p.width : a.left;
      if (top < 8) top = a.bottom + 8; // flip
      if (top + p.height > window.innerHeight - 8)
        top = Math.max(8, window.innerHeight - p.height - 8);
      left = Math.min(Math.max(8, left), window.innerWidth - p.width - 8);
      setPos({ left, top });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [open, anchor, placement]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose(true);
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, anchor, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      className="pop fixed max-h-[60vh] overflow-y-auto"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width:
          width ??
          (matchAnchorWidth
            ? anchor.current?.getBoundingClientRect().width
            : undefined),
        zIndex: z,
        visibility: pos ? 'visible' : 'hidden',
      }}
      role="dialog"
    >
      {children}
    </div>,
    document.body,
  );
}

/** Touch/coarse-pointer devices: hover tooltips stick open, so skip them. */
function useHasHover(): boolean {
  const [hasHover, setHasHover] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia('(hover: hover) and (pointer: fine)');
    const update = () => setHasHover(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return hasHover;
}

/** Lightweight hover/focus tooltip. */
export function Tip({
  label,
  children,
  side = 'top',
}: {
  label: string | null;
  children: ReactNode;
  side?: 'top' | 'bottom';
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasHover = useHasHover();

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    if (!show) return;
    const hide = () => setShow(false);
    document.addEventListener('pointerdown', hide, true);
    window.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('scroll', hide, true);
    };
  }, [show]);

  const enter = () => {
    if (!label || !hasHover) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setShow(true), 180);
  };
  const leave = () => {
    if (timer.current) clearTimeout(timer.current);
    setShow(false);
  };

  if (!hasHover) return <>{children}</>;

  let top = 0;
  let left = 0;
  const box = ref.current?.firstElementChild ?? ref.current;
  if (box) {
    const r = box.getBoundingClientRect();
    left = r.left + r.width / 2;
    top = side === 'top' ? r.top - 6 : r.bottom + 6;
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: passive wrapper that tracks hover/focus of its child
    <span
      ref={ref}
      className="contents"
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={enter}
      onBlur={leave}
    >
      {children}
      {show && label && (
        <span
          className="pop fixed -translate-x-1/2 whitespace-pre-line px-2 py-1 text-[11px] leading-snug"
          style={{
            left,
            top,
            zIndex: 30,
            transform: `translate(-50%, ${side === 'top' ? '-100%' : '0'})`,
            maxWidth: 260,
            color: 'var(--text-2)',
          }}
          role="tooltip"
        >
          {label}
        </span>
      )}
    </span>
  );
}

/** Dropdown menu (avatar, row ⋯). Reuses Popover surface. */
export type MenuItem =
  | { sep: true; label?: undefined; onSelect?: undefined; danger?: undefined }
  | {
      sep?: undefined | false;
      label: string;
      onSelect: () => void;
      danger?: boolean | undefined;
    };

export function Menu({
  open,
  anchor,
  onClose,
  items,
  placement = 'bottom-end',
  width = 180,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  onClose: (restoreFocus: boolean) => void;
  items: MenuItem[];
  placement?: Placement;
  width?: number;
}) {
  const isAction = (i: number) => {
    const it = items[i];
    return !!it && !it.sep;
  };
  const nextAction = (from: number, dir: 1 | -1) => {
    let i = from;
    for (let n = 0; n < items.length; n++) {
      i = (i + dir + items.length) % items.length;
      if (isAction(i)) return i;
    }
    return from;
  };
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const latest = useRef({ items, idx, onClose, nextAction });
  latest.current = { items, idx, onClose, nextAction };

  useEffect(() => {
    if (!open) return;
    const l = latest.current;
    setIdx(l.nextAction(-1, 1));
    const onKey = (e: KeyboardEvent) => {
      const { items, idx, onClose, nextAction } = latest.current;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setIdx((i) => nextAction(i, 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setIdx((i) => nextAction(i, -1));
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const it = items[idx];
        if (it && !it.sep) {
          it.onSelect();
          onClose(true);
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    listRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  return (
    <Popover
      open={open}
      anchor={anchor}
      onClose={onClose}
      placement={placement}
      width={width}
      z={40}
    >
      <div ref={listRef} tabIndex={-1} className="py-1 outline-none">
        {items.map((item, k) =>
          item.sep ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity
            <div key={k} className="my-1 border-t border-[var(--border)]" />
          ) : (
            <button
              type="button"
              key={item.label}
              className={`flex w-full items-center px-3 py-1.5 text-left text-[13px] ${
                k === idx && open
                  ? 'bg-[var(--sunken)]'
                  : 'hover:bg-[var(--sunken)]'
              } ${item.danger ? 'text-[var(--danger)]' : 'text-[var(--text)]'}`}
              onMouseEnter={() => setIdx(k)}
              onClick={() => {
                item.onSelect();
                onClose(false);
              }}
            >
              {item.label}
            </button>
          ),
        )}
      </div>
    </Popover>
  );
}

/*
 * useTouchDrag — pointer-driven drag & drop for sidebar rows on touch screens.
 *
 * Business logic:
 * - Mobile browsers never fire HTML5 dragstart (long-press on iOS selects
 *   text, Android scrolls or shows its own drag ghost), so filing a chat
 *   into a folder from the drawer needs pointer events. The row being
 *   dragged fades in place and a DragGhost — a fixed copy of it, lifted
 *   with a shadow — follows the finger.
 * - A press that moves past DRAG_THRESHOLD picks the row up; a press that
 *   stops within it still taps the link, and a swipe still scrolls.
 * - The pressed element captures the pointer, so the drop target is read
 *   with elementFromPoint. Targets carry data-drop-id (a folder id, or ''
 *   for the unfiled rest of the list), which keeps the thread visible
 *   underneath the drawer from matching.
 * - Holding near the list's top or bottom edge scrolls it, so a chat can
 *   be filed into a folder that is currently off screen.
 * - Nothing under the finger on release means nothing moves; Esc or a
 *   cancelled pointer drops the drag. A click ending a drag is swallowed
 *   so the row doesn't navigate too.
 */
'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { Drag } from './drag';

/* a press that moves this far (px) picks the row up instead of tapping it */
export const DRAG_THRESHOLD = 8;
const EDGE = 56;
const MAX_SPEED = 12;

type Live = {
  drag: Drag;
  /* where in the viewport the press started */
  origin: { x: number; y: number };
  /* where the finger is, viewport px */
  x: number;
  y: number;
  /* the list edge the finger holds while it scrolls */
  scroll: -1 | 0 | 1;
  /* what the finger is over: folder id, '' for the unfiled area, null for neither */
  target: string | null;
};

type TouchDragValue = {
  live: Live | null;
  /* arms a row on pointerdown and picks it up once the finger moves */
  begin: (drag: Drag, e: React.PointerEvent<HTMLElement>) => void;
  /* the list's root element, itself the unfiled drop zone */
  zone: React.RefObject<HTMLElement | null>;
  /* the nearest scrolling ancestor of the list, whose edges scroll it */
  scope: () => HTMLElement | null;
};

const Ctx = createContext<TouchDragValue | null>(null);

/** the zone under a viewport point: folder id, '' for the unfiled area, null for neither */
export function dropIdAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  const zone = el?.closest('[data-drop-id]');
  return zone instanceof HTMLElement ? (zone.dataset.dropId ?? '') : null;
}

export function TouchDragProvider({
  canDrop,
  onDrop,
  children,
}: {
  canDrop: (target: string | null) => boolean;
  onDrop: (drag: Drag, target: string | null) => void;
  children: ReactNode;
}) {
  const [live, setLive] = useState<Live | null>(null);
  const [swallow, setSwallow] = useState(false);
  const zone = useRef<HTMLElement | null>(null);

  const scope = useCallback(() => {
    for (
      let el = zone.current?.parentElement;
      el && el !== document.body;
      el = el.parentElement
    )
      if (
        el.scrollHeight > el.clientHeight + 1 &&
        getComputedStyle(el).overflowY !== 'visible'
      )
        return el;
    return null;
  }, []);

  const begin = useCallback(
    (drag: Drag, e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType === 'mouse' || e.button !== 0) return;
      const from = { x: e.clientX, y: e.clientY };
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - from.x;
        const dy = ev.clientY - from.y;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        /* from here on the finger drags the row, not the list */
        ev.preventDefault();
        release();
        setSwallow(true);
        setLive({
          drag,
          origin: from,
          x: ev.clientX,
          y: ev.clientY,
          scroll: 0,
          target: null,
        });
      };
      const release = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', release);
        window.removeEventListener('pointercancel', release);
      };
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', release);
      window.addEventListener('pointercancel', release);
    },
    [],
  );

  /* while a row is held: follow the finger, scroll at the edges, track the target */
  const kind = live?.drag.kind;
  const id = live?.drag.id;
  useEffect(() => {
    if (kind === undefined || id === undefined) return;
    const drag = { kind, id };
    const targetOf = (x: number, y: number) => {
      const hit = dropIdAt(x, y);
      const folder = hit || null;
      return hit !== null && canDrop(folder) ? folder : null;
    };
    /* the viewport height stands in until the list is measured */
    const box = () =>
      scope()?.getBoundingClientRect() ??
      ({ top: 0, bottom: window.innerHeight } as DOMRect);
    const edgeAt = (y: number) => {
      const r = box();
      if (y < r.top + EDGE) return -1 as const;
      if (y > r.bottom - EDGE) return 1 as const;
      return 0 as const;
    };

    let point = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const onMove = (e: PointerEvent) => {
      point = { x: e.clientX, y: e.clientY };
      const edge = edgeAt(point.y);
      setLive((l) =>
        l
          ? {
              ...l,
              x: point.x,
              y: point.y,
              scroll: edge,
              target: targetOf(point.x, point.y),
            }
          : l,
      );
    };

    let last = performance.now();
    let raf = requestAnimationFrame(function frame(now) {
      const el = scope();
      const dt = Math.min(64, now - last) / 16;
      last = now;
      if (el) {
        const edge = edgeAt(point.y);
        const room =
          edge < 0
            ? el.scrollTop > 0
            : el.scrollTop + el.clientHeight < el.scrollHeight - 1;
        if (edge !== 0 && room) {
          el.scrollTop += edge * MAX_SPEED * dt;
          /* the list moved under a steady finger: re-read what is under it */
          setLive((l) =>
            l ? { ...l, scroll: edge, target: targetOf(point.x, point.y) } : l,
          );
        }
      }
      raf = requestAnimationFrame(frame);
    });

    const finish = (drop: boolean) => {
      /* a cancelled drag (Esc, pointercancel) files nothing */
      if (drop) {
        const folder = targetOf(point.x, point.y);
        if (folder !== null) onDrop(drag, folder);
      }
      setLive(null);
    };
    const onUp = (e: PointerEvent) => {
      point = { x: e.clientX, y: e.clientY };
      finish(true);
    };
    const onCancel = () => finish(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(false);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    /* keep the page and the drawer from panning under the ghost */
    const gate = (e: TouchEvent) => e.preventDefault();
    document.addEventListener('touchmove', gate, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('touchmove', gate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps — one set of listeners per drag, still reading the live state through setLive
  }, [kind, id]);

  /* swallow the click a finished drag would otherwise send to the row's link */
  useEffect(() => {
    if (!swallow) return;
    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setSwallow(false);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [swallow]);

  const value = useMemo<TouchDragValue>(
    () => ({ live, begin, zone, scope }),
    [live, begin, scope],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTouchDrag() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTouchDrag outside TouchDragProvider');
  return ctx;
}

/**
 * Draggable — a row that arms itself on pointerdown and moves a ghost copy
 * of itself once the finger drags it.
 */
export function Draggable({
  drag,
  children,
  className,
  zone,
  ...rest
}: {
  drag: Drag;
  children: ReactNode;
  className?: string;
  /* marks a folder row as that folder's drop zone; omit to be the unfiled area */
  zone?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'children' | 'className'>) {
  const { live, begin } = useTouchDrag();
  const ref = useRef<HTMLDivElement | null>(null);
  const dragging = live?.drag.kind === drag.kind && live.drag.id === drag.id;
  return (
    <div
      ref={ref}
      /* '' files into the folder the row lives in; rows outside folders are the unfiled area */
      data-drop-id={zone ?? ''}
      {...rest}
      onPointerDown={(e) => begin(drag, e)}
      className={`${className ?? ''} ${dragging ? 'opacity-30' : ''}`}
    >
      {children}
      {dragging && live && ref.current && (
        <Ghost from={ref.current} live={live} />
      )}
    </div>
  );
}

/** a fixed copy of the dragged row, pinned under the finger */
function Ghost({ from, live }: { from: HTMLElement; live: Live }) {
  const html = useMemo(
    () =>
      from.outerHTML
        .replace(/ id="[^"]*"/g, '')
        .replace(/<(input|textarea|select)\b[\s\S]*?<\/\1>/g, '')
        .replace(/<(input|textarea|select)\b[^>]*>/g, '')
        .replace(/<a\b/g, '<span')
        .replace(/<\/a>/g, '</span>'),
    [from],
  );
  /* the row's box, taken once so the ghost doesn't chase the finger */
  const [box] = useState(() => from.getBoundingClientRect());
  return createPortal(
    <div
      aria-hidden="true"
      className="pointer-events-none fixed z-[70] overflow-hidden border border-[var(--accent)] bg-[var(--panel)]"
      style={{
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        transform: `translate(${live.x - live.origin.x}px, ${live.y - live.origin.y}px) scale(1.02)`,
        boxShadow: 'var(--shadow-pop)',
        touchAction: 'none',
      }}
      /* a static copy of this row's own markup */
      // biome-ignore lint/security/noDangerouslySetInnerHtml: copied from the row rendered just above
      dangerouslySetInnerHTML={{ __html: html }}
    />,
    document.body,
  );
}

/**
 * ListZone — the wrapper whose empty space (below the rows, between the
 * headers) is the unfiled drop zone.
 */
export function ListZone({
  children,
  ...rest
}: Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> & {
  children: ReactNode;
}) {
  const { zone } = useTouchDrag();
  return (
    <div
      ref={(el) => {
        zone.current = el;
      }}
      data-drop-id=""
      {...rest}
    >
      {children}
    </div>
  );
}

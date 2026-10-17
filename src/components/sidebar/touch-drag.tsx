/*
 * useTouchDrag — pointer-driven drag & drop for rows on touch screens.
 *
 * Business logic:
 * - Mobile browsers never fire HTML5 dragstart (long-press on iOS selects
 *   text, Android scrolls or shows its own drag ghost), so filing a chat
 *   into a folder from the sidebar's mobile drawer is pointer events only.
 * - A press that moves past DRAG_THRESHOLD picks up the row; one that
 *   stops first still taps the link, and an unpicked press leaves the
 *   drawer free to scroll.
 * - Because the pointer is captured, document.elementFromPoint tells us
 *   what sits under the finger; the target is looked up through
 *   `data-drop-id` (folder id, '' for the unfiled area), which isolates
 *   the sidebar from the thread underneath the drawer.
 * - Holding near the top or bottom edge scrolls the list, so a chat can be
 *   filed into a folder that is currently off screen; the drag follows
 *   the edge while it scrolls.
 * - A click that ends the drag is swallowed so the row doesn't also
 *   navigate, and the click event right after a tap that never dragged is
 *   left alone.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Drag, TouchDrag } from './drag';
import { DRAG_THRESHOLD } from './drag';

const EDGE = 56;
const MAX_SPEED = 12;
const LIFT = 1.02;
/* a settled position is re-measured against the scrolling list */
const SETTLE_MS = 220;

/** the drop target under a viewport point: folder id, '' for the unfiled area, null for nothing */
export function dropIdAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  const zone = el?.closest('[data-drop-id]');
  return zone instanceof HTMLElement ? (zone.dataset.dropId ?? null) : null;
}

export function useTouchDrag({
  scroller,
  canDrop,
  onDrop,
}: {
  /* the list that scrolls at the edges */
  scroller: React.RefObject<HTMLDivElement | null>;
  canDrop: (target: string | null) => boolean;
  onDrop: (drag: Drag, target: string | null) => void;
}) {
  const [td, setTd] = useState<TouchDrag | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const scratch = useRef<{ drag: Drag; node: HTMLElement; start: { x: number; y: number } } | null>(null);
  const swallowClick = useRef(false);

  /* a tap that began on a row and never picked it up must still click it */
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  const begin = useCallback(
    (drag: Drag, node: HTMLElement, point: { x: number; y: number }) => {
      scratch.current = { drag, node, start: point };
    },
    [],
  );

  /* the row under the finger fed back new settled coordinates */
  const settled = useCallback((live: TouchDrag['live']) => {
    setTd((d) =>
      d ? { ...d, offset: { x: live.x, y: live.y }, live } : d,
    );
  }, []);

  useEffect(() => {
    if (!td) return;
    const { drag } = td;
    let point = { x: td.x, y: td.y };
    let at = { x: td.live.x, y: td.live.y };
    let edge: -1 | 0 | 1 = 0;
    let raf = 0;
    let last = performance.now();

    const inZone = (x: number, y: number) => {
      const id = dropIdAt(x, y);
      return id !== null && canDrop(id === '' ? null : id) ? id : null;
    };

    const frame = (now: number) => {
      const dt = Math.min(64, now - last) / 16;
      last = now;
      const el = scroller.current;
      if (edge !== 0 && el) {
        el.scrollTop += edge * MAX_SPEED * dt;
        at = { x: at.x, y: at.y + edge * MAX_SPEED * dt };
        setTd((d) =>
          d ? { ...d, scroll: edge, live: { ...d.live, x: at.x, y: at.y } } : d,
        );
        setTarget(inZone(point.x, point.y));
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const onMove = (e: PointerEvent) => {
      point = { x: e.clientX, y: e.clientY };
      const el = scroller.current;
      let next = 0;
      if (el) {
        const r = el.getBoundingClientRect();
        if (e.clientY < r.top + EDGE) next = -1;
        else if (e.clientY > r.bottom - EDGE) next = 1;
      }
      edge = next;
      if (next === 0) at = { x: point.x, y: point.y };
      const lift = at === point ? 1 : LIFT;
      setTd((d) =>
        d
          ? {
              ...d,
              x: point.x,
              y: point.y,
              scroll: next,
              live: { x: at.x, y: at.y, k: lift },
            }
          : d,
      );
      setTarget(inZone(point.x, point.y));
    };

    const onEnd = () => {
      /* only a real drop files anything; a cancelled drag (pointercancel, Esc, unmount) just lets go */
      if (filter === 'drop') onDrop(drag, target);
      setTd(null);
      setTarget(null);
    };

    let filter = 'cancel';
    const onUp = () => {
      filter = 'drop';
      onEnd();
    };
    const onCancel = () => onEnd();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEnd();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    const gate = (e: TouchEvent) => {
      if (td) e.preventDefault();
    };
    document.addEventListener('touchmove', gate, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('touchmove', gate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps — listeners read the latest render's target through the ref below
  }, [td, scroller, canDrop, onDrop, target]);

  const handlers = useCallback(
    (drag: Drag) => ({
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        if (e.pointerType === 'mouse' || e.button !== 0) return;
        const node = e.currentTarget as HTMLElement;
        begin(drag, node, { x: e.clientX, y: e.clientY });
        const from = { x: e.clientX, y: e.clientY };

        const onMove = (ev: PointerEvent) => {
          const r = scratch.current;
          if (!r || r.node !== node) return;
          const dx = ev.clientX - from.x;
          const dy = ev.clientY - from.y;
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
          if (td || !node.isConnected) {
            detach();
            return;
          }
          ev.preventDefault();
          swallowClick.current = true;
          setTd({
            drag,
            x: ev.clientX,
            y: ev.clientY,
            scroll: 0,
            offset: { x: dx, y: dy },
            live: { x: dx, y: dy, k: 1 },
          });
          detach();
        };
        const onUp = () => detach();
        const onCancel = () => detach();
        const detach = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onCancel);
          if (scratch.current?.node === node) scratch.current = null;
        };
        window.addEventListener('pointermove', onMove, { passive: false });
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
      },
    }),
    [begin, td],
  );

  return {
    /* pointer handlers that pick a row up */
    handlers,
    /* live drag; the list filters it out while the row measures its new place */
    active: td,
    /* drop id under the finger, '' for the unfiled area, null when none */
    target,
    /* the row under the finger reports its settled translation */
    settled,
  };
}

/** a finger's measured translation toward a point, written so the row can animate to it */
export function liveOffset(d: TouchDrag): string {
  return `translate(${d.offset.x}px, ${d.offset.y}px) scale(1)`;
}

/** transform while dragging: tracks the finger and lifts off the list */
export function dragStyle(d: TouchDrag): React.CSSProperties {
  const x = d.live.x;
  const y = d.live.y;
  return {
    transform: `translate(${x}px, ${y}px) scale(${d.live.k})`,
    zIndex: 60,
    position: 'relative',
    boxShadow: 'var(--shadow-pop)',
    borderColor: 'var(--accent)',
    touchAction: 'none',
  };
}

export { LIFT, DRAG_THRESHOLD };

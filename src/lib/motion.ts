/*
 * motion — exit-animation support for conditionally rendered surfaces.
 *
 * Business logic:
 * - React unmounts immediately, but sheets and panels want to animate
 *   out. useExitDelay keeps the tree mounted for a fixed window after
 *   `open` drops: `exiting` goes true (the caller swaps to its exit
 *   classes) and `mounted` drops once the timer matches the CSS
 *   duration, removing the tree.
 * - Only an actual open→closed transition schedules the timer, so a
 *   surface that was never open stays inert; reopening inside the
 *   window cancels the exit and re-enters.
 * - A timer, not animationend, drives the final unmount so reduced
 *   motion, interrupted animations, or a missed event can't strand a
 *   translucent scrim or off-screen sheet in the DOM.
 * - Consumers: the mobile drawer (shell), the right panel sheet and
 *   its inline width reveal.
 */
'use client';

import { useEffect, useRef, useState } from 'react';

export function useExitDelay(open: boolean, ms = 200) {
  const [state, setState] = useState(() => ({ mounted: open, exiting: false }));
  const timer = useRef(0);
  const prevOpen = useRef(open);

  useEffect(() => {
    const was = prevOpen.current;
    prevOpen.current = open;
    if (open) {
      window.clearTimeout(timer.current);
      setState((s) =>
        s.mounted && !s.exiting ? s : { mounted: true, exiting: false },
      );
      return;
    }
    if (!was) return;
    setState((s) => (s.mounted ? { ...s, exiting: true } : s));
    timer.current = window.setTimeout(() => {
      setState({ mounted: false, exiting: false });
    }, ms);
    return () => window.clearTimeout(timer.current);
  }, [open, ms]);

  return state;
}

/*
 * useLayoutStore / layoutActions — the chrome around a conversation:
 * sidebar and right-panel size, which panel/tab is open, the preview
 * snippet, and the viewport width everything else keys off.
 *
 * Business logic:
 * - persisted are the sidebar ({width, collapsed} → 'layout.sidebar') and
 *   the panel width ('layout.rightPanel'); every set() rewrites both and
 *   boot seeds them back. which panel is open is never stored — boot
 *   always starts closed.
 * - widths are clamped on write, sidebar 200–360 and right panel
 *   280–720, so a drag can't push the layout off screen.
 * - two panel modes (context|artifact) carry three tabs: preview is a tab
 *   inside artifact mode, not a mode of its own.
 * - lastPanel remembers the mode last shown and closePanel keeps it, so
 *   togglePanel (mod+.) reopens whatever the reader was using.
 * - openPreview stores the raw html/svg snippet with its chatId and msgId,
 *   which is how the preview tab can hide a snippet whose chat or branch
 *   is no longer on screen.
 * - vw arrives from the shell's resize listener and is only written when
 *   it changes by more than 1px, so dragging doesn't churn subscribers;
 *   the shell rails the sidebar between 768 and 1100px, and the panel
 *   renders inline at ≥1440px, as a scrim overlay under that.
 * - mobileNav is the small-screen sidebar drawer, closed on boot and
 *   force-closed below 768px.
 */
'use client';

import { create } from 'zustand';
import { LS } from '../lib/storage';

export type PanelMode = 'closed' | 'context' | 'artifact';

export type PanelTab = 'context' | 'artifact' | 'preview';

export type PreviewSnippet = {
  code: string;
  language: 'html' | 'svg';
  /* the message the snippet came from, so it hides when that branch is scoped out */
  msgId: string;
  chatId: string;
};

type LayoutState = {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  rightPanel: PanelMode;
  rightPanelWidth: number;
  /* which tab the open right panel shows; preview lives here, not as a mode */
  rightPanelTab: PanelTab;
  lastPanel: Exclude<PanelMode, 'closed'>;
  /* what the preview tab renders; null when nothing was opened yet */
  preview: PreviewSnippet | null;
  mobileNav: boolean;
  vw: number;
};

export const useLayoutStore = create<LayoutState>()(() => ({
  sidebarWidth: 264,
  sidebarCollapsed: false,
  rightPanel: 'closed',
  rightPanelWidth: 420,
  rightPanelTab: 'context',
  lastPanel: 'context',
  preview: null,
  mobileNav: false,
  vw: 1440,
}));

const get = useLayoutStore.getState;
const set = (patch: Partial<LayoutState>) => {
  useLayoutStore.setState(patch);
  const s = get();
  LS.set('layout.sidebar', {
    width: s.sidebarWidth,
    collapsed: s.sidebarCollapsed,
  });
  LS.set('layout.rightPanel', { width: s.rightPanelWidth });
};

export const layoutActions = {
  toggleSidebar() {
    set({ sidebarCollapsed: !get().sidebarCollapsed });
  },
  setSidebarWidth(w: number) {
    set({ sidebarWidth: Math.min(360, Math.max(200, w)) });
  },
  setRightPanelWidth(w: number) {
    set({ rightPanelWidth: Math.min(720, Math.max(280, w)) });
  },
  setMobileNav(open: boolean) {
    set({ mobileNav: open });
  },
  openPanel(kind: 'context' | 'artifact') {
    set({ rightPanel: kind, rightPanelTab: kind, lastPanel: kind });
  },
  /* shows a raw html/svg snippet in the preview tab of the right panel */
  openPreview(snippet: PreviewSnippet) {
    set({
      preview: snippet,
      rightPanel: 'artifact',
      rightPanelTab: 'preview',
      lastPanel: 'artifact',
    });
  },
  setRightPanelTab(tab: PanelTab) {
    const kind = tab === 'context' ? 'context' : 'artifact';
    set({ rightPanelTab: tab, rightPanel: kind, lastPanel: kind });
  },
  closePanel() {
    set({ rightPanel: 'closed' });
  },
  /* reopens whichever panel was used last */
  togglePanel() {
    const s = get();
    set({ rightPanel: s.rightPanel === 'closed' ? s.lastPanel : 'closed' });
  },
  setVw(vw: number) {
    if (Math.abs(vw - get().vw) > 1) useLayoutStore.setState({ vw });
  },
};

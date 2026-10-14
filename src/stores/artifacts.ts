/*
 * useArtifactsStore / artifactsActions — which artifact the right panel
 * is pointed at, and how it's shown.
 *
 * Business logic:
 * - pure session state: nothing here is fetched or persisted, the panel
 *   owns the artifact data and only reads this pointer; a selection that
 *   went stale (another chat, a branch without it) falls back there to
 *   the artifact that changed last.
 * - version: null follows the newest version as the model writes more;
 *   selectArtifactVersion pins one, and passing null resumes following.
 * - view is the preview|code switch, kept across artifacts and chats.
 * - openArtifact (an artifact card click, the panel's picker) stores the
 *   selection and always opens the right panel in artifact mode.
 * - revealArtifact is called from the thread stream as artifact tool
 *   calls land: it repoints at the newest version, but pops the panel
 *   open only when it isn't already showing an artifact and vw ≥ 1440,
 *   so a narrow layout isn't covered mid-stream.
 */
'use client';

import { create } from 'zustand';
import { layoutActions, useLayoutStore } from './layout';

type ArtifactsState = {
  /* what the panel shows; anything stale (another chat, a branch without it) falls back to the latest */
  chatId: string | null;
  id: string | null;
  /* null follows the newest version as the model writes more */
  version: number | null;
  view: 'preview' | 'code';
};

export const useArtifactsStore = create<ArtifactsState>()(() => ({
  chatId: null,
  id: null,
  version: null,
  view: 'preview',
}));

const set = useArtifactsStore.setState;

export const artifactsActions = {
  openArtifact(chatId: string, id: string, version: number | null = null) {
    set({ chatId, id, version });
    layoutActions.openPanel('artifact');
  },
  /** called as versions stream in: follows them, but only pops the panel where it fits inline */
  revealArtifact(chatId: string, id: string) {
    set({ chatId, id, version: null });
    const { rightPanel, vw } = useLayoutStore.getState();
    if (rightPanel !== 'artifact' && vw >= 1440)
      layoutActions.openPanel('artifact');
  },
  selectArtifactVersion(version: number | null) {
    set({ version });
  },
  setArtifactView(view: 'preview' | 'code') {
    set({ view });
  },
};

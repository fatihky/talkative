/*
 * PrefsStore — theme, enterToSend and spellcheck; the store is the Prefs
 * object itself, per browser only.
 *
 * Business logic:
 * - nothing here talks to the server: boot() seeds the store from
 *   localStorage 'prefs', with 'theme' read separately so the theme
 *   survives even when the cached prefs predate a field.
 * - every write persists both keys — setPrefs stores the whole object
 *   under 'prefs' and the theme under 'theme', then re-applies it;
 *   cycleTheme walks light → dark → system, which is what the topbar's
 *   theme button does.
 * - applyTheme is the only place the DOM learns the theme: it sets
 *   data-theme on <html>, resolving 'system' against
 *   prefers-color-scheme, and shell re-runs it when that query changes.
 * - enterToSend decides whether a bare Enter sends or inserts a newline
 *   in the composer and the message edit box (⌘/Ctrl+Enter always sends,
 *   Shift+Enter always breaks), and spellcheck is passed through to the
 *   composer textarea.
 * - defaults are theme 'system', enterToSend on, spellcheck on.
 */
'use client';

import { create } from 'zustand';
import { LS } from '../lib/storage';
import type { Prefs } from '../types';

export const defaultPrefs = (): Prefs => ({
  theme: 'system',
  enterToSend: true,
  spellcheck: true,
});

export const usePrefsStore = create<Prefs>()(defaultPrefs);

const set = usePrefsStore.setState;
const get = usePrefsStore.getState;

export const prefsActions = {
  applyTheme() {
    const { theme } = get();
    const dark =
      theme === 'dark' ||
      (theme === 'system' &&
        window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  },
  cycleTheme() {
    const order: Prefs['theme'][] = ['light', 'dark', 'system'];
    const next = order[(order.indexOf(get().theme) + 1) % 3] ?? 'system';
    set({ theme: next });
    LS.set('theme', next);
    prefsActions.applyTheme();
  },
  setPrefs(patch: Partial<Prefs>) {
    set(patch);
    LS.set('prefs', get());
    LS.set('theme', get().theme);
    prefsActions.applyTheme();
  },
};

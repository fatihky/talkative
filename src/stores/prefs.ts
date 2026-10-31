/*
 * PrefsStore — theme, enterToSend and spellcheck; the store is the Prefs
 * object itself.
 *
 * Business logic:
 * - theme and spellcheck are per browser only: boot() seeds them from
 *   localStorage 'prefs', with 'theme' read separately so the theme
 *   survives even when the cached prefs predate a field.
 * - enterToSend is an account-level preference (UserPrefs, stored under
 *   'user:<id>' in app_settings): boot() keeps the cached copy for the
 *   first paint and then applies the saved one through applyAccountPrefs,
 *   so it follows a user to every device. savePreferences() writes the
 *   change both locally (so a reload paints instantly) and to the server;
 *   a failed save toasts and keeps the local value, like tool prefs.
 * - once the user changes enterToSend locally, a late boot fetch can't
 *   clobber that edit (accountPrefsTouched).
 * - applyTheme/cycleTheme are the only places the DOM learns the theme:
 *   they set data-theme on <html>, resolving 'system' against
 *   prefers-color-scheme, and shell re-runs applyTheme when that query
 *   changes.
 * - enterToSend decides whether a bare Enter sends or inserts a newline
 *   in the composer and the message edit box (⌘/Ctrl+Enter always sends,
 *   Shift+Enter always breaks), and spellcheck is passed through to the
 *   composer textarea.
 * - defaults are theme 'system', enterToSend on, spellcheck on.
 */
'use client';

import { create } from 'zustand';
import { userPreferencesApi } from '../lib/api';
import { LS } from '../lib/storage';
import type { Prefs, UserPrefs } from '../types';
import { uiActions } from './ui';

export const defaultPrefs = (): Prefs => ({
  theme: 'system',
  enterToSend: true,
  spellcheck: true,
});

export const usePrefsStore = create<Prefs>()(defaultPrefs);

const set = usePrefsStore.setState;
const get = usePrefsStore.getState;

/* set once the user edits enterToSend, so a late boot fetch can't clobber it */
let accountPrefsTouched = false;

const errorText = (e: unknown) =>
  e instanceof Error ? e.message : 'unknown error';

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
  /** browser-only prefs (theme, spellcheck) */
  setPrefs(patch: Partial<Prefs>) {
    set(patch);
    LS.set('prefs', get());
    LS.set('theme', get().theme);
    prefsActions.applyTheme();
  },
  /** applies the account prefs fetched at boot, unless the user already changed one */
  applyAccountPrefs(p: UserPrefs) {
    if (accountPrefsTouched) return;
    if (typeof p.enterToSend !== 'boolean') return;
    prefsActions.setPrefs({ enterToSend: p.enterToSend });
  },
  /** the composer's Enter key: true sends, false inserts a newline */
  setEnterToSend(on: boolean) {
    accountPrefsTouched = true;
    prefsActions.setPrefs({ enterToSend: on });
    userPreferencesApi.patch({ enterToSend: on }).catch((err) => {
      console.error('[prefs] save failed:', errorText(err));
      uiActions.toast(`Could not save preference: ${errorText(err)}`, 'error');
    });
  },
};

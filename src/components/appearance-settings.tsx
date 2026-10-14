/*
 * AppearanceSettings — theme and composer preferences page.
 *
 * Business logic:
 * - Edits the local prefs store only: preferences are per-browser and
 *   never sent to the server, so another device starts from defaults.
 * - Theme is light/dark/system; `system` resolves against the OS scheme
 *   when applied and the shell re-applies it when the OS changes.
 * - Every change persists to localStorage and repaints `data-theme` on
 *   <html> right away; boot reads the standalone `theme` key back.
 * - Composer rules: `enterToSend` decides whether plain Enter sends
 *   (Shift+Enter always inserts a newline), `spellcheck` drives the
 *   textarea's spellCheck attribute.
 * - Defaults: theme `system`, both composer toggles on.
 */
'use client';

import { actions, usePrefsStore } from '../stores';

export function AppearanceSettings() {
  const prefs = usePrefsStore();
  return (
    <section className="rounded-[8px] border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="sec-label mb-2">Theme</div>
      <div className="flex items-center gap-3">
        {(['light', 'dark', 'system'] as const).map((t) => (
          <label
            key={t}
            className="flex cursor-pointer items-center gap-1.5 text-[13px]"
          >
            <input
              type="radio"
              checked={prefs.theme === t}
              onChange={() => actions.setPrefs({ theme: t })}
              className="accent-[var(--accent)]"
            />
            {t}
          </label>
        ))}
      </div>
      <div className="sec-label mb-2 mt-4">Composer</div>
      <div className="flex flex-col gap-2">
        <label className="flex cursor-pointer items-center justify-between text-[13px]">
          <span>Enter sends message (Shift+Enter for newline)</span>
          <input
            type="checkbox"
            checked={prefs.enterToSend}
            onChange={(e) => actions.setPrefs({ enterToSend: e.target.checked })}
            className="size-3.5 accent-[var(--accent)]"
          />
        </label>
        <label className="flex cursor-pointer items-center justify-between text-[13px]">
          <span>Spellcheck in composer</span>
          <input
            type="checkbox"
            checked={prefs.spellcheck}
            onChange={(e) => actions.setPrefs({ spellcheck: e.target.checked })}
            className="size-3.5 accent-[var(--accent)]"
          />
        </label>
      </div>
    </section>
  );
}

/*
 * AppearanceSettings — theme and composer preferences page.
 *
 * Business logic:
 * - Theme and spellcheck edit the local prefs store only: they are
 *   per-browser and never sent to the server, so another device starts
 *   from its own copy. Every change persists to localStorage and
 *   repaints `data-theme` on <html> right away; boot reads the standalone
 *   `theme` key back.
 * - The Enter-key choice is account-level (`enterToSend` in UserPrefs):
 *   it is patched to /api/user-preferences and follows the user to every
 *   device, with the local copy kept for an instant reload. The radio
 *   also names the shortcut that overrides it — Shift+Enter always breaks
 *   a line and ⌘/Ctrl+Enter always sends.
 * - Defaults: theme `system`, Enter sends, spellcheck on.
 */
'use client';

import { actions, usePrefsStore, useUIStore } from '../stores';
import { Kbd } from '../ui/primitives';

const ENTER_CHOICES = [
  { value: true, label: 'Send the message' },
  { value: false, label: 'Insert a new line' },
] as const;

export function AppearanceSettings() {
  const prefs = usePrefsStore();
  const mod = useUIStore((s) => s.mod);
  return (
    <>
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
      </section>
      <section className="rounded-[8px] border border-[var(--border)] bg-[var(--panel)] p-3">
        <div className="sec-label mb-2">Composer</div>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Enter key behaviour</legend>
          <div className="text-[13px]">
            Pressing <Kbd>⏎</Kbd> in the composer should
          </div>
          <div className="flex flex-col gap-1.5">
            {ENTER_CHOICES.map((c) => (
              <label
                key={String(c.value)}
                className="flex cursor-pointer items-center gap-1.5 text-[13px]"
              >
                <input
                  type="radio"
                  name="composer-enter"
                  checked={prefs.enterToSend === c.value}
                  onChange={() => actions.setEnterToSend(c.value)}
                  className="accent-[var(--accent)]"
                />
                {c.label}
              </label>
            ))}
          </div>
          <p className="text-[11px] muted">
            Shift+Enter always inserts a new line, {mod}+Enter always sends.
            Saved to your account, so it applies on every device.
          </p>
        </fieldset>
        <label className="mt-4 flex cursor-pointer items-center justify-between text-[13px]">
          <span>Spellcheck in composer</span>
          <input
            type="checkbox"
            checked={prefs.spellcheck}
            onChange={(e) => actions.setPrefs({ spellcheck: e.target.checked })}
            className="size-3.5 accent-[var(--accent)]"
          />
        </label>
      </section>
    </>
  );
}

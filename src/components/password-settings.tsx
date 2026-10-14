/*
 * PasswordSettings — self-service password change on /settings/account.
 *
 * Business logic:
 * - Collapsed by default: the form hides inside a <details> row so the
 *   account page doesn't show password fields until asked for.
 * - The current password is required and re-verified by better-auth, so
 *   the change only ever comes from someone who already knows it.
 * - The 8-char minimum (better-auth's own) and the two-fields-must-match
 *   rule are checked locally before any request goes out.
 * - A rejected change (wrong current password, too weak) shows the
 *   server's message inline; success clears all three fields and toasts.
 * - The submit button is disabled while the change is in flight.
 * - There is no admin reset path anywhere in the UI: an account created
 *   in the users panel gets its password once, at creation.
 */
'use client';

import { type FormEvent, useState } from 'react';
import { authClient } from '../lib/auth-client';
import { I } from '../lib/icons';
import { actions } from '../stores';

const inputCls =
  'h-8 w-full rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] px-2 text-[13px] outline-none focus:border-[var(--accent)]';

const MIN_PASSWORD = 8;

export function PasswordSettings() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next.length < MIN_PASSWORD) {
      setError(`New password must be at least ${MIN_PASSWORD} characters`);
      return;
    }
    if (next !== confirm) {
      setError('New passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
      });
      setCurrent('');
      setNext('');
      setConfirm('');
      actions.toast('Password updated');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="group rounded-[8px] border border-[var(--border)] bg-[var(--panel)]">
      <summary className="flex h-10 cursor-pointer list-none items-center gap-2 px-3 [&::-webkit-details-marker]:hidden">
        <I n="key" s={14} className="muted" />
        <span className="text-[13px] font-medium">Change password</span>
        <I
          n="chevron-down"
          s={12}
          className="ml-auto shrink-0 opacity-60 transition-transform group-open:rotate-180"
        />
      </summary>
      <form
        onSubmit={(e) => void submit(e)}
        className="flex flex-col gap-2 border-t border-[var(--border)] p-3"
      >
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="muted">Current password</span>
          <input
            required
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="muted">New password</span>
          <input
            required
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="muted">Confirm new password</span>
          <input
            required
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={inputCls}
          />
        </label>
        {error && (
          <div className="text-[12px] text-[var(--danger)]">{error}</div>
        )}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={busy}
            className="ctl-primary h-7 rounded-[6px] px-3 text-[12px]"
          >
            {busy ? 'Updating…' : 'Update password'}
          </button>
        </div>
      </form>
    </details>
  );
}
/*
 * UserManagement — the admin account list on /settings/users.
 *
 * Business logic:
 * - Admin only: GET /api/users 403s for everyone else and that specific
 *   failure hides the whole panel, so a regular user sees nothing rather
 *   than an error or an empty user list.
 * - Lists every account on the instance, oldest first, badging admins;
 *   accounts are otherwise equal here.
 * - Add user creates a credential account (name, email, 8+ char
 *   password) exactly the way self sign-up would, and a duplicate email
 *   is rejected with the server's message.
 * - Created users are never admins — only the instance's first registered
 *   user is promoted automatically; granting and revoking admin goes
 *   through `pnpm admin:grant` / `admin:revoke`, not this UI.
 * - Editing changes name and email only: there's no password reset and no
 *   delete, so an account's password is set once, at creation.
 * - A saved user is upserted into the local list instead of refetching
 *   everyone; failures show inline and keep the form open with its input.
 */
'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, usersApi } from '../lib/api';
import { errorText } from '../stores/models';
import type { AdminUser } from '../types';
import { IconButton } from '../ui/primitives';

const inputCls =
  'h-8 w-full rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] px-2 text-[13px] outline-none focus:border-[var(--accent)]';

export function UserManagement() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'hidden'>(
    'loading',
  );
  const [error, setError] = useState<string | undefined>();
  /* null = closed, 'new' = add form, otherwise the user being edited */
  const [editing, setEditing] = useState<'new' | AdminUser | null>(null);

  useEffect(() => {
    usersApi
      .list()
      .then((u) => {
        setUsers(u);
        setStatus('ready');
      })
      .catch((e: unknown) => {
        /* non-admins get a 403 and never see this panel */
        if (e instanceof ApiError && e.status === 403) setStatus('hidden');
        else {
          setError(errorText(e));
          setStatus('error');
        }
      });
  }, []);

  if (status === 'hidden') return null;

  const upsert = (u: AdminUser) =>
    setUsers((list) => {
      const i = list.findIndex((x) => x.id === u.id);
      if (i === -1) return [...list, u];
      const next = [...list];
      next[i] = u;
      return next;
    });

  return (
    <section className="rounded-[8px] border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="mb-2 flex items-center">
        <div className="sec-label">Users</div>
        {status === 'ready' && editing === null && (
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="ctl ml-auto h-7 rounded-[6px] px-2 text-[12px]"
          >
            Add user
          </button>
        )}
      </div>

      {status === 'error' && (
        <div className="mb-2 text-[12px] text-[var(--danger)]">{error}</div>
      )}

      <div className="flex flex-col">
        {users.map((u) => (
          <div
            key={u.id}
            className="flex min-h-9 items-center gap-2 border-b border-[var(--border)] text-[12px] last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{u.name}</span>
                {u.isAdmin && (
                  <span className="shrink-0 rounded-[4px] bg-[var(--sunken)] px-1 text-[10px] muted">
                    admin
                  </span>
                )}
              </div>
              <div className="truncate muted">{u.email}</div>
            </div>
            <IconButton
              icon="pencil"
              tip="Edit user"
              ghost
              size={24}
              onClick={() => setEditing(u)}
            />
          </div>
        ))}
      </div>

      {editing !== null && (
        <UserForm
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          onSave={(u) => {
            upsert(u);
            setEditing(null);
          }}
          onDone={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function UserForm({
  initial,
  onSave,
  onDone,
}: {
  initial: AdminUser | null;
  onSave: (u: AdminUser) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = initial
        ? await usersApi.update(initial.id, { name, email })
        : await usersApi.create({ name, email, password });
      onSave(u);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="mt-3 flex flex-col gap-2 rounded-[6px] border border-[var(--border)] p-3"
    >
      <label className="flex flex-col gap-1 text-[12px]">
        <span className="muted">Name</span>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputCls}
        />
      </label>
      <label className="flex flex-col gap-1 text-[12px]">
        <span className="muted">Email</span>
        <input
          required
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputCls}
        />
      </label>
      {!initial && (
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="muted">Password</span>
          <input
            required
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputCls}
          />
        </label>
      )}
      {error && <div className="text-[12px] text-[var(--danger)]">{error}</div>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="ctl-ghost h-7 rounded-[6px] px-2 text-[12px]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="ctl-primary h-7 rounded-[6px] px-3 text-[12px]"
        >
          {busy ? 'Saving…' : initial ? 'Save' : 'Add user'}
        </button>
      </div>
    </form>
  );
}
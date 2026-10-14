/*
 * ToolCredentials — the user's own API keys for tool providers, on
 * /settings/tool-keys.
 *
 * Business logic:
 * - Keys belong to one user and are stored encrypted; the API only ever
 *   returns hasApiKey, so the UI can show that a key exists but never
 *   what it is (and never prefills the form).
 * - A row is rendered for every known tool provider (tavily, serper.dev,
 *   serpapi, exa, scrape.do, searxng, github), keyed or not, so it's
 *   obvious which tools need a key of their own.
 * - A user key always beats the environment key when a tool runs; only
 *   when there is none does the shared key get used, if policy allows.
 * - The env hint is access-controlled: admins see the variable name
 *   behind the provider, everyone else just "global key configured", and
 *   only when the site's envKeyAccess admits them (admins by default). No
 *   badge at all means the user must bring their own key.
 * - Saving PUTs the key and reloads the whole list rather than patching
 *   it locally; Remove DELETEs just that provider and falls back to the
 *   env key when one is still admissible.
 * - A blank key can't be submitted, failures show inline and keep the
 *   form open, and nothing renders until the first load settles.
 */
'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { toolCredentialsApi, type ToolCredentialsResponse } from '../lib/api';
import { errorText } from '../stores/models';
import type { ToolCredential } from '../types';
import { IconButton } from '../ui/primitives';

const inputCls =
  'h-8 w-full rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] px-2 text-[13px] outline-none focus:border-[var(--accent)]';

export function ToolCredentials() {
  const [data, setData] = useState<ToolCredentialsResponse | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [error, setError] = useState<string | undefined>();
  /* the provider id currently being edited; null = closed */
  const [editing, setEditing] = useState<string | null>(null);

  const load = () =>
    toolCredentialsApi
      .get()
      .then((d) => {
        setData(d);
        setStatus('ready');
      })
      .catch((e: unknown) => {
        setError(errorText(e));
        setStatus('error');
      });

  useEffect(() => {
    void load();
  }, []);

  if (status === 'loading') return null;

  const providers = data?.providers ?? [];
  const admin = data?.isAdmin ?? false;
  const creds = new Map((data?.items ?? []).map((c) => [c.provider, c]));

  const save = async (provider: string, apiKey: string | null) => {
    setError(undefined);
    try {
      await toolCredentialsApi.put({ provider, apiKey });
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const remove = async (provider: string) => {
    setError(undefined);
    try {
      await toolCredentialsApi.remove(provider);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section className="rounded-[8px] border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="sec-label mb-1">Tool keys</div>
      <p className="mb-2 text-[12px] muted">
        Bring your own API keys for the tools that need them. Stored encrypted
        and used only for your chats.
      </p>
      {status === 'error' && (
        <div className="mb-2 text-[12px] text-[var(--danger)]">{error}</div>
      )}
      <div className="flex flex-col">
        {providers.map((p) => {
          const cred = creds.get(p.id);
          const set = cred?.hasApiKey;
          /* admins are told which env var covers the provider, everyone else just that
             a shared key exists; when neither applies the row stays silent so the user
             knows they have to bring their own key */
          const shared = p.envShared
            ? admin
              ? `${p.env ?? 'environment key'} already set`
              : 'global key configured'
            : undefined;
          return (
            <div
              key={p.id}
              className="flex min-h-9 items-center gap-2 border-b border-[var(--border)] text-[12px] last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{p.label}</span>
                  {set && (
                    <span className="rounded-[4px] bg-[var(--sunken)] px-1 text-[10px] muted">
                      own key
                    </span>
                  )}
                  {shared && (
                    <span className="truncate rounded-[4px] bg-[var(--sunken)] px-1 text-[10px] muted">
                      {shared}
                    </span>
                  )}
                </div>
                <div className="truncate muted">{p.id}</div>
              </div>
              {set ? (
                <>
                  <IconButton
                    icon="pencil"
                    tip="Replace key"
                    ghost
                    size={24}
                    onClick={() => setEditing(p.id)}
                  />
                  <IconButton
                    icon="trash"
                    tip="Remove key"
                    ghost
                    size={24}
                    onClick={() => void remove(p.id)}
                  />
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditing(p.id)}
                  className="ctl h-7 rounded-[6px] px-2 text-[12px]"
                >
                  Set key
                </button>
              )}
            </div>
          );
        })}
      </div>
      {editing !== null && (
        <KeyForm
          provider={editing}
          onSubmit={async (apiKey) => {
            await save(editing, apiKey);
          }}
          onDone={() => setEditing(null)}
        />
      )}
      {error && (
        <div className="mt-2 text-[12px] text-[var(--danger)]">{error}</div>
      )}
    </section>
  );
}

function KeyForm({
  provider,
  onSubmit,
  onDone,
}: {
  provider: string;
  onSubmit: (apiKey: string) => Promise<void>;
  onDone: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(apiKey.trim());
      onDone();
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
        <span className="muted">API key for {provider}</span>
        <input
          required
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className={inputCls}
        />
      </label>
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
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

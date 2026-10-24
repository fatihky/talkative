/*
 * SiteSettings — instance-wide policy: sign-ups and environment tool keys.
 *
 * Business logic:
 * - Admins only, enforced twice: GET /api/settings 403s for everyone else
 *   and the error path renders nothing, so a non-admin who lands on the
 *   route sees an empty page instead of a forbidden error or the controls.
 * - The response's isAdmin is checked again before rendering.
 * - "Allow new registrations" opens or closes sign-up instance-wide; the
 *   first registered user is made admin, so closing it afterwards is the
 *   normal way to keep an instance private.
 * - Environment tool keys (TAVILY_API_KEY, GITHUB_PAT, …) get an access
 *   policy — everyone / admins only (the default) / no one — deciding who
 *   may run tools on the shared key; a user's own key always wins.
 * - Each change PATCHes immediately and merges the server's reply back
 *   into local state: there is no save button and no local draft.
 * - Both controls are disabled while a save is in flight, and a failed
 *   save reports inline while the old values stay on screen.
 */
'use client';

import { useEffect, useState } from 'react';
import type { SiteSettingsResponse } from '../lib/api';
import { settingsApi } from '../lib/api';
import { errorText } from '../stores/models';
import type { EnvKeyAccess } from '../types';
import { Switch } from '../ui/primitives';

export function SiteSettings() {
  const [data, setData] = useState<SiteSettingsResponse | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    settingsApi
      .get()
      .then((d) => {
        setData(d);
        setStatus('ready');
      })
      .catch((e: unknown) => {
        setError(errorText(e));
        setStatus('error');
      });
  }, []);

  if (status === 'loading') return null;
  if (status === 'error') return null;
  /* non-admins don't see site settings at all */
  if (!data?.isAdmin) return null;

  const setRegistration = async (enabled: boolean) => {
    setSaving(true);
    setError(undefined);
    try {
      const next = await settingsApi.patch({ registrationEnabled: enabled });
      setData((d) => (d ? { ...d, ...next } : d));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const setEnvKeyAccess = async (access: EnvKeyAccess) => {
    setSaving(true);
    setError(undefined);
    try {
      const next = await settingsApi.patch({ envKeyAccess: access });
      setData((d) => (d ? { ...d, ...next } : d));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-[8px] border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="sec-label mb-2">Site</div>
      {/* biome-ignore lint/a11y/noLabelWithoutControl: wraps a Switch, which is a button */}
      <label className="flex items-center justify-between text-[13px]">
        <span>
          Allow new registrations
          <span className="ml-2 text-[11px] muted">
            {data.registrationEnabled
              ? 'anyone may create an account'
              : 'sign-up is closed'}
          </span>
        </span>
        <Switch
          checked={data.registrationEnabled}
          disabled={saving}
          onChange={(v) => void setRegistration(v)}
          label="Allow new registrations"
        />
      </label>
      <div className="mt-3 border-t border-[var(--border)] pt-3">
        <div className="text-[13px]">Environment API keys</div>
        <div className="text-[11px] muted">
          Who may use the tool keys defined in the server environment
          (TAVILY_API_KEY, GITHUB_PAT, …)
        </div>
        <select
          value={data.envKeyAccess}
          onChange={(e) => void setEnvKeyAccess(e.target.value as EnvKeyAccess)}
          disabled={saving}
          className="mt-2 h-8 w-full rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] px-2 text-[13px] outline-none focus:border-[var(--accent)]"
        >
          <option value="all">Everyone</option>
          <option value="admins">Admins only</option>
          <option value="none">No one (every user must bring their own)</option>
        </select>
      </div>
      {error && (
        <div className="mt-2 text-[12px] text-[var(--danger)]">{error}</div>
      )}
    </section>
  );
}

/*
 * ShellWrapper — auth gate deciding which layout wraps the page.
 *
 * Business logic:
 * - Mirrors better-auth's useSession into the UI store on every change.
 * - Renders nothing while the session check is pending, so the anonymous
 *   layout never flashes for logged-in users.
 * - Anonymous visitors get bare children (login/register screens) with no
 *   shell chrome; authenticated users get the full Shell.
 */
'use client';

import { useEffect } from 'react';
import { authClient } from '../lib/auth-client';
import { actions, useUIStore } from '../stores';
import { Shell } from './shell';

export function ShellWrapper({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const authLoading = useUIStore((s) => s.authLoading);
  const isAuthenticated = useUIStore((s) => s.isAuthenticated);

  /* sync auth state to store whenever useSession updates */
  useEffect(() => {
    if (isPending) {
      actions.setAuthState(true, false);
    } else {
      actions.setAuthState(false, !!session);
    }
  }, [isPending, session]);

  /* while checking session: render nothing */
  if (authLoading) {
    return null;
  }

  /* not logged in: anonymous layout (no shell chrome) */
  if (!isAuthenticated) {
    return <div className="h-dvh">{children}</div>;
  }

  /* logged in: full shell */
  return <Shell>{children}</Shell>;
}

/*
 * RootLayout (every route) — the app shell wrapped around all pages.
 *
 * Business logic:
 * - renders statically; nothing here reads the session or the db, so all
 *   per-request decisions live in the client shell and the api routes.
 * - delegates chrome to ShellWrapper: signed-in users get the sidebar and
 *   topbar, everyone else (auth pages, public /a/<id>) gets a bare
 *   full-height container.
 * - owns the global stylesheet, favicon, and the default meta description;
 *   the auth layout adds its own description for the sign-in pages.
 */
import '../styles.css';

import type { ReactNode } from 'react';
import { ShellWrapper } from '../components/shell-wrapper';

type RootLayoutProps = { children: ReactNode };

export default async function RootLayout({ children }: RootLayoutProps) {
  return (
    <div className="h-dvh">
      <meta
        name="description"
        content="Talkative — per-message tool grants, model composition, one clean stage."
      />
      <link rel="icon" type="image/png" href="/images/favicon.png" />
      <ShellWrapper>{children}</ShellWrapper>
    </div>
  );
}

export const getConfig = async () => {
  return {
    render: 'static',
  } as const;
};

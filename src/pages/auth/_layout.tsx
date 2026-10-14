/* AuthLayout (/auth/*) — sign-in pages: own meta, no app chrome, static. */
import type { ReactNode } from 'react';

type AuthLayoutProps = { children: ReactNode };

export default async function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className="h-dvh">
      <meta
        name="description"
        content="Talkative — Sign in to access your account."
      />
      <link rel="icon" type="image/png" href="/images/favicon.png" />
      {children}
    </div>
  );
}

export const getConfig = async () => {
  return {
    render: 'static',
  } as const;
};

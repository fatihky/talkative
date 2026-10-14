/*
 * Page — generic placeholder screen for non-home routes.
 *
 * Business logic:
 * - Sets the UI context to 'new' on mount so the ever-present composer
 *   keeps sending from the home draft rather than a chat.
 */
'use client';

import { useEffect } from 'react';
import { actions } from '../stores';

/** Generic placeholder region for non-home routes; composer still targets home draft. */
export function Page({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    actions.setContext('new');
  }, []);
  return (
    <main className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
      <div className="mx-auto w-full max-w-[640px]">
        <h1 className="mb-1 text-[20px] font-semibold leading-[1.35]">
          {title}
        </h1>
        <p className="mb-6 text-[12px] muted">
          Secondary screen — scaffolded for navigation completeness. The
          composer below still sends from the home draft.
        </p>
        {children}
      </div>
    </main>
  );
}

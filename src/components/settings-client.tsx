/*
 * SettingsClient — the settings hub, plus the header/sub-page chrome every
 * settings route reuses.
 *
 * Business logic:
 * - The hub only navigates: each area lives on its own route, so leaving
 *   a form never strands unsaved state in the hub.
 * - Providers and models were merged into one "Providers & models" page
 *   instead of two entries describing the same catalog.
 * - Grouped Personal (appearance, account) / Models (providers, tools,
 *   tool keys) / Content (memories, shared artifacts), with Admin appended.
 * - isAdmin comes from GET /api/settings, which is admin-only; a 403 or
 *   any other failure leaves it false, so Site and Users simply never
 *   render for a regular user rather than rendering and failing.
 * - The memories count appears only once that store is ready, so a
 *   still-loading hub doesn't show a wrong 0.
 * - SettingsHeader's back label is derived from the target route and the
 *   hub itself backs out to the chats; sub-pages back out to /settings.
 */
'use client';

import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useState,
} from 'react';
import { Link } from 'waku';
import { settingsApi } from '../lib/api';
import { I } from '../lib/icons';
import { useMemoriesStore } from '../stores';

type LinkTo = ComponentProps<typeof Link>['to'];

type NavItem = {
  to: LinkTo;
  icon: string;
  label: string;
  desc: string;
  count?: number | undefined;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

export function SettingsHeader({
  title,
  back,
}: {
  title: string;
  back: '/' | '/settings' | '/settings/memories';
}) {
  return (
    <header className="flex h-[var(--h-topbar)] shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg)] px-2 max-md:h-[var(--h-topbar)]">
      <Link
        to={back}
        aria-label={
          back === '/'
            ? 'Back to chats'
            : `Back to ${back.slice(back.lastIndexOf('/') + 1)}`
        }
        className="ctl-icon border-transparent bg-transparent text-[var(--text-2)] hover:bg-[var(--sunken)] hover:text-[var(--text)]"
      >
        <I n="arrow-left" s={15} />
      </Link>
      <span className="text-[13px] font-semibold">{title}</span>
    </header>
  );
}

export function SettingsSubPage({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsHeader title={title} back="/settings" />
      <main className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
          {children}
        </div>
      </main>
    </div>
  );
}

export function SettingsClient() {
  const memories = useMemoriesStore((s) => s.items);
  const memoriesReady = useMemoriesStore((s) => s.status === 'ready');
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let active = true;
    settingsApi
      .get()
      .then((d) => {
        if (active) setIsAdmin(!!d.isAdmin);
      })
      .catch(() => {
        if (active) setIsAdmin(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const groups: NavGroup[] = [
    {
      label: 'Personal',
      items: [
        {
          to: '/settings/appearance',
          icon: 'sun',
          label: 'Appearance',
          desc: 'Theme and composer behavior',
        },
        {
          to: '/settings/account',
          icon: 'key',
          label: 'Account',
          desc: 'Change your password',
        },
      ],
    },
    {
      label: 'Models',
      items: [
        {
          to: '/settings/providers',
          icon: 'settings',
          label: 'Providers & models',
          desc: 'Connect providers and manage models',
        },
        {
          to: '/settings/tools',
          icon: 'wrench',
          label: 'Tools',
          desc: 'Default tools for new chats',
        },
        {
          to: '/settings/tool-keys',
          icon: 'key',
          label: 'Tool keys',
          desc: 'Bring your own keys for tools',
        },
      ],
    },
    {
      label: 'Content',
      items: [
        {
          to: '/settings/memories',
          icon: 'note',
          label: 'Memories',
          desc: 'Durable facts shared across chats',
          count: memoriesReady ? memories.length : undefined,
        },
        {
          to: '/settings/artifacts',
          icon: 'globe',
          label: 'Shared artifacts',
          desc: 'Artifacts you have published',
        },
      ],
    },
    ...(isAdmin
      ? ([
          {
            label: 'Admin',
            items: [
              {
                to: '/settings/site' as const,
                icon: 'sliders',
                label: 'Site',
                desc: 'Registration and environment keys',
              },
              {
                to: '/settings/users' as const,
                icon: 'user',
                label: 'Users',
                desc: 'Manage accounts',
              },
            ],
          },
        ] satisfies NavGroup[])
      : []),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsHeader title="Settings" back="/" />
      <main className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto flex w-full max-w-[640px] flex-col gap-6">
          {groups.map((g) => (
            <section key={g.label} className="flex flex-col gap-1">
              <div className="sec-label mb-1 px-1">{g.label}</div>
              {g.items.map((item) => (
                <Link
                  key={item.label}
                  to={item.to}
                  className="flex h-10 items-center gap-2 rounded-[8px] border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] hover:border-[var(--border-strong)]"
                >
                  <I n={item.icon} s={14} className="muted" />
                  <span className="shrink-0">{item.label}</span>
                  {item.count !== undefined && (
                    <span className="num text-[11px] muted">{item.count}</span>
                  )}
                  <span className="ml-auto truncate pl-4 text-[11px] muted">
                    {item.desc}
                  </span>
                </Link>
              ))}
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}

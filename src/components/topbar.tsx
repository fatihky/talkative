/*
 * Topbar — global header: sidebar toggle, wordmark, search, help, theme,
 * settings, account, preview, and right-panel toggle.
 *
 * Business logic:
 * - The sidebar button opens the mobile drawer below 768px and toggles
 *   rail collapse at ≥768px.
 * - The palette trigger is a full search bar at ≥1100px and a bare icon
 *   below it; both open the command palette.
 * - The theme button cycles light → dark → system via cycleTheme.
 * - The preview button appears only while a scoped preview snippet is
 *   valid (its source message still on the branch on screen) and opens
 *   the preview tab of the right panel.
 * - Sign out calls better-auth then routes to /auth/login; failures
 *   surface as an error toast.
 * - The account chip (initials avatar) and menu (name + email) read the
 *   live session via authClient.useSession; the menu navigates to
 *   /settings.
 */
'use client';

import { useMemo, useRef, useState } from 'react';
import { Link, useRouter } from 'waku';
import { authClient } from '../lib/auth-client';
import { I } from '../lib/icons';
import { Menu, Tip } from '../lib/popover';
import { actions, useLayoutStore, usePrefsStore, useUIStore } from '../stores';
import { IconButton, Kbd } from '../ui/primitives';
import { useScopedPreview } from './preview-panel';

export function Topbar() {
  const router = useRouter();
  const vw = useLayoutStore((s) => s.vw);
  const mod = useUIStore((s) => s.mod);
  const collapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const rightPanel = useLayoutStore((s) => s.rightPanel);
  const rightPanelTab = useLayoutStore((s) => s.rightPanelTab);
  const preview = useScopedPreview();
  const theme = usePrefsStore((s) => s.theme);
  const menuOpen = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState(false);
  const { data: session } = authClient.useSession();

  const userName = session?.user?.name ?? '';
  const userEmail = session?.user?.email ?? '';
  const initials = useMemo(() => {
    const parts = userName.trim().split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] ?? userEmail[0] ?? '';
    const second =
      parts.length > 1
        ? (parts[parts.length - 1]?.[0] ?? '')
        : (userName[1] ?? userEmail[1] ?? '');
    return (first + second).toUpperCase();
  }, [userName, userEmail]);

  const themeIcon =
    theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'monitor';
  const themeTip = `Theme: ${theme} — click for next`;

  const paletteTrigger =
    vw < 1100 ? (
      <Tip label={`Search ${mod}K`} side="bottom">
        <button
          type="button"
          aria-label="Open command palette"
          onClick={() => actions.setPalette(true)}
          className="ctl-icon"
        >
          <I n="search" s={14} />
        </button>
      </Tip>
    ) : (
      <button
        type="button"
        aria-label="Open command palette"
        onClick={() => actions.setPalette(true)}
        className="flex h-8 w-full max-w-[520px] min-w-0 flex-1 items-center gap-2 rounded-[7px] border border-[var(--border)] bg-[var(--bg)] px-2 text-[13px] text-[var(--text-3)] transition-colors hover:border-[var(--border-strong)] focus-visible:outline-none md:mx-0"
      >
        <I n="search" s={14} />
        <span className="min-w-0 flex-1 truncate text-left">
          Search chats, messages, notes, settings…
        </span>
        <Kbd>{mod}K</Kbd>
      </button>
    );

  return (
    <header className="flex h-[var(--h-topbar)] shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg)] px-2 max-md:h-[var(--h-topbar)]">
      <IconButton
        icon="panel-left"
        tip={`Toggle sidebar ${mod}B`}
        ghost
        active={!collapsed}
        onClick={() =>
          vw < 768 ? actions.setMobileNav(true) : actions.toggleSidebar()
        }
      />
      {vw >= 768 && (
        <Link
          to="/"
          className="num ml-1 hidden h-8 shrink-0 items-center gap-1.5 rounded-[6px] px-1 text-[13px] font-semibold tracking-tight text-[var(--text)] no-underline hover:bg-[var(--sunken)] md:flex"
          aria-label="Talkative home"
        >
          <span className="flex size-5 items-center justify-center rounded-[6px] bg-[var(--accent)] text-[var(--text-inv)]">
            <I n="chat" s={12} />
          </span>
          Talkative
        </Link>
      )}
      <div className="flex min-w-0 flex-1 px-1 md:pl-2 md:pr-0">
        {paletteTrigger}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          icon="help"
          tip="Help & shortcuts"
          ghost
          onClick={() => actions.setHelp(true)}
        />
        <IconButton
          icon={themeIcon}
          tip={themeTip}
          ghost
          onClick={() => actions.cycleTheme()}
        />
        <Tip label="Settings" side="bottom">
          <Link
            to="/settings"
            className="ctl-icon border-transparent bg-transparent text-[var(--text-2)] hover:bg-[var(--sunken)] hover:text-[var(--text)]"
            aria-label="Settings"
          >
            <I n="settings" s={15} />
          </Link>
        </Tip>
        <button
          ref={menuOpen}
          type="button"
          aria-label="Account menu"
          aria-expanded={menu}
          onClick={() => setMenu((v) => !v)}
          className="ml-1 flex size-6 shrink-0 items-center justify-center rounded-[4px] border border-[var(--border)] bg-[var(--accent-weak)] text-[10px] font-semibold text-[var(--accent)] hover:border-[var(--border-strong)]"
        >
          {initials || '?'}
        </button>
        {preview && (
          <IconButton
            icon="play"
            tip="Open preview"
            ghost
            active={rightPanel === 'artifact' && rightPanelTab === 'preview'}
            onClick={() => actions.openPreview(preview)}
          />
        )}
        <IconButton
          icon="panel-right"
          tip={`Toggle right panel ${mod}.`}
          ghost
          active={rightPanel !== 'closed'}
          onClick={() => actions.togglePanel()}
        />
        <Menu
          open={menu}
          anchor={menuOpen}
          onClose={() => setMenu(false)}
          items={[
            {
              label: userName || 'Account',
              onSelect: () => actions.navigateTo('/settings'),
            },
            {
              label: userEmail || 'Settings',
              onSelect: () => actions.navigateTo('/settings'),
            },
            { sep: true },
            {
              label: 'Sign out',
              onSelect: async () => {
                try {
                  await authClient.signOut();
                  void router.push('/auth/login');
                } catch (err) {
                  actions.toast(
                    err instanceof Error ? err.message : 'Failed to sign out',
                    'error',
                  );
                }
              },
              danger: true,
            },
          ]}
        />
      </div>
    </header>
  );
}

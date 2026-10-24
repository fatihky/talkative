/*
 * Shell — the authenticated app frame: topbar, sidebar, routed content,
 * composer, right panel, dialogs, toasts, and global keyboard routing.
 *
 * Business logic:
 * - Boots the stores once and watches window resize + system color scheme.
 * - §10 responsive: crossing below 1100px collapses the sidebar to a rail
 *   and crossing back restores it; below 768px the sidebar becomes a
 *   scrim drawer and an open drawer closes.
 * - The mobile drawer slides in/out with its scrim (useExitDelay keeps
 *   it mounted while the exit animation runs); the right panel manages
 *   its own enter/exit animations the same way.
 * - /settings and public artifact links (/a/*) render standalone with no
 *   sidebar, composer, or panels; note and decision detail routes also drop
 *   the composer (both are editors, not a chat), and so does /search.
 * - pendingNav — a route path or bare chat id left by the send flow or
 *   banner actions — is pushed once, then cleared.
 * - Global shortcuts (mod+k/n/b/., ctrl+t, ctrl+shift+p, mod+/) are
 *   suspended while the command palette is open (§7.3).
 * - '?' opens help only outside inputs and only when no overlay is up;
 *   Esc closes the mobile drawer before the right panel and yields to
 *   palette/help, which handle their own Esc.
 */
'use client';

import { type ComponentProps, useCallback, useEffect, useRef } from 'react';
import { type Link, useRouter } from 'waku';
import { I } from '../lib/icons';
import { useKeyboardScope } from '../lib/keyboard';
import { useExitDelay } from '../lib/motion';
import { actions, useLayoutStore, useUIStore } from '../stores';
import { Composer } from './composer/composer';
import { ConfirmDialog } from './confirm-dialog';
import { HelpDialog } from './help-dialog';
import { CommandPalette } from './palette';
import { PromptDialog } from './prompt-dialog';
import { RightPanel } from './right-panel';
import { Sidebar } from './sidebar';
import { GlobalStatusBar } from './status-bar';
import { SystemPromptDialog } from './system-prompt-dialog';
import { ToolConfirmDialog } from './tool-confirm-dialog';
import { Topbar } from './topbar';

type RoutePath = Extract<ComponentProps<typeof Link>['to'], string>;

export function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const vw = useLayoutStore((s) => s.vw);
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);
  const _sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const mobileNav = useLayoutStore((s) => s.mobileNav);
  const paletteOpen = useUIStore((s) => s.palette);
  const context = useUIStore((s) => s.context);
  const drawer = useExitDelay(mobileNav);

  /* the private chat theme (distinct accent) follows the active context */
  useEffect(() => {
    const el = document.documentElement;
    if (context === 'private') el.dataset.private = 'true';
    else delete el.dataset.private;
  }, [context]);

  /* boot once; global resize + system theme watcher */
  useEffect(() => {
    actions.boot();
    const onResize = () => actions.setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => actions.applyTheme();
    mq.addEventListener('change', onScheme);
    return () => {
      window.removeEventListener('resize', onResize);
      mq.removeEventListener('change', onScheme);
    };
  }, []);

  /* §10 — auto collapse to rail below 1100; restore above */
  const booted = useUIStore((s) => s.booted);
  const prevVw = useRef(1440);
  useEffect(() => {
    if (!booted) return;
    const was = prevVw.current;
    prevVw.current = vw;
    if (
      vw < 1100 &&
      vw >= 768 &&
      was >= 1100 &&
      !useLayoutStore.getState().sidebarCollapsed
    )
      actions.toggleSidebar();
    if (vw >= 1100 && was < 1100 && useLayoutStore.getState().sidebarCollapsed)
      actions.toggleSidebar();
    if (vw < 768 && useLayoutStore.getState().mobileNav)
      actions.setMobileNav(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vw, booted]);

  const openChat = useCallback(
    (path: string) => void router.push(path as RoutePath),
    [router],
  );

  /* pending navigation produced by the send flow / banner actions */
  const pendingNav = useUIStore((s) => s.pendingNav);
  useEffect(() => {
    if (pendingNav !== null) {
      /* pendingNav is either a route path or a bare chat id */
      const to = (
        pendingNav.startsWith('/') ? pendingNav : `/c/${pendingNav}`
      ) as RoutePath;
      void router.push(to);
      actions.clearPendingNav();
    }
  }, [pendingNav, router]);

  /* keyboard scope — global app shortcuts; suspended while palette is open */
  const kb = useKeyboardScope('home');
  kb.bind({
    'mod+k': () => actions.setPalette(true),
    'mod+n': () => actions.newChat(),
    'mod+b': () => actions.toggleSidebar(),
    'mod+.': () => actions.togglePanel(),
    'ctrl+t': () => actions.openModelBarPopover('tools'),
    'ctrl+shift+p': () => actions.openModelBarPopover('params'),
    'mod+/': () => actions.focusComposer(),
  });
  useEffect(() => {
    /* suspend all app shortcuts while the palette overlay is open (§7.3) */
    kb.suspend(paletteOpen);
  }, [paletteOpen, kb]);

  /* '?' opens help; not a scope binding since scopes would fire it while typing in inputs */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"]'))
        return;
      const ui = useUIStore.getState();
      if (
        ui.palette ||
        ui.help ||
        ui.systemPromptFor ||
        ui.confirmToolFor ||
        ui.confirm
      )
        return;
      e.preventDefault();
      actions.setHelp(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /* Esc closes drawer/panel first (popover Esc handled in Popover) */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (useUIStore.getState().palette) return; // palette handles its own Esc
      if (useUIStore.getState().help) return;
      if (useLayoutStore.getState().mobileNav) {
        actions.setMobileNav(false);
        return;
      }
      if (useLayoutStore.getState().rightPanel !== 'closed') {
        actions.closePanel();
        return;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const isMobile = vw < 768;
  const showSidebar = !isMobile;

  /* settings is a standalone screen: no chat chrome (sidebar, composer, panels);
     a public artifact link is too */
  const standalone =
    router.path === '/settings' ||
    router.path.startsWith('/settings/') ||
    router.path.startsWith('/a/');
  if (standalone)
    return (
      <div className="flex h-dvh flex-col overflow-hidden bg-[var(--bg)] text-[var(--text)]">
        {children}
        <CommandPalette onOpenChat={openChat} />
        <SystemPromptDialog />
        <ToolConfirmDialog />
        <HelpDialog />
        <ConfirmDialog />
        <PromptDialog />
        <ToastHost />
      </div>
    );

  /* a note or a decision run is an editor, not a chat, and search is a results page: no composer */
  const noComposer =
    /^\/notes\/[^/]+/.test(router.path) ||
    /^\/decisions\/[^/]+/.test(router.path) ||
    router.path === '/search';

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <Topbar />

      <div className="flex min-h-0 flex-1">
        {showSidebar && <Sidebar />}
        <div className="flex min-w-0 flex-1 flex-col">
          {children}
          {!noComposer && (
            <div className="shrink-0 px-2 pb-[max(12px,env(safe-area-inset-bottom))] pt-1 sm:px-6">
              <Composer />
            </div>
          )}
        </div>

        {/* inline at ≥1440, sheet overlay below (decided inside RightPanel);
            it delays its own unmount through the exit animation */}
        <RightPanel />
      </div>

      <GlobalStatusBar />

      {/* mobile drawer — slides in from the left over a fading scrim */}
      {isMobile && drawer.mounted && (
        <div
          className={`fixed inset-0 z-50 ${
            drawer.exiting
              ? 'anim-scrim-out pointer-events-none'
              : 'anim-scrim-in'
          }`}
          style={{ background: 'var(--scrim)' }}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) actions.setMobileNav(false);
          }}
        >
          <div
            className={`absolute left-0 top-0 h-full ${
              drawer.exiting
                ? 'anim-out-left pointer-events-none'
                : 'anim-in-left'
            }`}
          >
            {/* the close bar matches the drawer's stored sidebar width, so
                the two pieces line up even after the sidebar was resized */}
            <div
              className="flex h-[var(--h-topbar)] shrink-0 items-center justify-end border-b border-[var(--border)] bg-[var(--panel)] pr-2"
              style={{ width: sidebarWidth }}
            >
              <button
                type="button"
                aria-label="Close sidebar"
                onClick={() => actions.setMobileNav(false)}
                className="ctl-icon border-transparent bg-transparent"
              >
                <I n="x" s={14} />
              </button>
            </div>
            <div className="h-[calc(100%-var(--h-topbar))]">
              <Sidebar inDrawer />
            </div>
          </div>
        </div>
      )}

      <CommandPalette onOpenChat={openChat} />
      <SystemPromptDialog />
      <ToolConfirmDialog />
      <HelpDialog />
      <ConfirmDialog />
      <PromptDialog />
      <ToastHost />
    </div>
  );
}

function ToastHost() {
  const toasts = useUIStore((s) => s.toasts);
  return (
    <div
      className="fixed bottom-8 right-4 z-[80] flex flex-col gap-1.5"
      aria-live="polite"
      role="status"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pop flex max-w-[320px] items-center gap-2 px-3 py-2 text-[12px]"
          style={{
            borderLeft: `2px solid ${t.level === 'error' ? 'var(--danger)' : t.level === 'warn' ? 'var(--warn)' : 'var(--accent)'}`,
          }}
        >
          <I
            n={t.level === 'error' ? 'alert' : 'info'}
            s={13}
            className="shrink-0 muted"
          />
          {t.text}
          <button
            type="button"
            aria-label="Dismiss"
            className="muted ml-1 shrink-0 hover:text-[var(--text)]"
            onClick={() => actions.dismissToast(t.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/*
 * Sidebar — left nav: new chat, chat filter, chat list, section links.
 *
 * Business logic:
 * - Collapses to an icon rail (new chat, expand, notes/decisions)
 *   when sidebarCollapsed is set — never inside the mobile drawer,
 *   which always renders full width.
 * - Collapsing/expanding animates: the nav's width slides between
 *   var(--w-rail) and the stored width while a clipping layer reveals
 *   the fixed-width content, so nothing inside reflows. The width
 *   transition is suspended while the resizer drags and never applies
 *   in the drawer.
 * - The edge resizer follows the pointer and snaps to the nearest of
 *   200/264/320/360 on release; double-click resets to 264. It only
 *   exists outside the drawer.
 * - The filter input drives ChatList's title/tag search; the folder-plus
 *   button creates a top-level folder.
 * - "New chat" and every section link close the mobile drawer.
 * - The highlighted chat comes from the UI context, which is null on the
 *   home ("new") screen.
 */
'use client';

import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { Link } from 'waku';
import { I } from '../../lib/icons';
import { Tip } from '../../lib/popover';
import {
  actions,
  useChatsStore,
  useLayoutStore,
  useUIStore,
} from '../../stores';
import { ChatList } from './chat-list';

type LinkTo = ComponentProps<typeof Link>['to'];

export function Sidebar({ inDrawer = false }: { inDrawer?: boolean }) {
  const width = useLayoutStore((s) => s.sidebarWidth);
  const collapsed = useLayoutStore((s) => s.sidebarCollapsed && !inDrawer);
  const activeId = useUIStore((s) => (s.context === 'new' ? null : s.context));
  const filterValue = useChatsStore((s) => s.filter);
  const mod = useUIStore((s) => s.mod);
  const chatItems = useChatsStore((s) => s.items);
  const resizer = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => actions.setSidebarWidth(e.clientX);
    const onUp = (e: PointerEvent) => {
      setDragging(false);
      const snaps = [200, 264, 320, 360];
      const best = snaps.reduce((a, b) =>
        Math.abs(b - e.clientX) < Math.abs(a - e.clientX) ? b : a,
      );
      actions.setSidebarWidth(best);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging]);

  return (
    <nav
      aria-label="Sidebar"
      className={`relative flex h-full shrink-0 flex-col border-r border-[var(--border)] bg-[var(--panel)] ${
        !inDrawer && !dragging ? 'anim-width' : ''
      }`}
      style={{ width: collapsed ? 'var(--w-rail)' : width }}
    >
      {/* clip layer — tracks the animating nav width and hides the
          fixed-width content while the nav slides between rail and full */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {collapsed ? (
          <div
            key="rail"
            className="anim-fade flex flex-1 flex-col items-center gap-1 py-1.5"
          >
            <Tip label={`New chat ${mod}N`} side="bottom">
              <button
                type="button"
                aria-label="New chat"
                onClick={() => actions.newChat()}
                className="flex size-8 items-center justify-center rounded-[6px] bg-[var(--accent)] text-[var(--text-inv)] hover:opacity-90"
              >
                <I n="plus" s={15} />
              </button>
            </Tip>
            <Tip label="Chats" side="bottom">
              <button
                type="button"
                aria-label="Expand sidebar"
                onClick={() => actions.toggleSidebar()}
                className="ctl-icon border-transparent bg-transparent"
              >
                <I n="chat" s={15} />
              </button>
            </Tip>
            <Tip label="Private chat" side="bottom">
              <button
                type="button"
                aria-label="Private chat"
                onClick={() => actions.navigateTo('/p')}
                className="ctl-icon border-transparent bg-transparent text-[var(--text-2)] hover:bg-[var(--sunken)]"
              >
                <I n="lock" s={15} />
              </button>
            </Tip>
            <div className="my-1 h-px w-6 bg-[var(--border)]" />
            <RailLink to="/" label="Home" icon="home" />
            <RailLink to="/notes" label="Notes" icon="note" />
            <RailLink to="/decisions" label="Decisions" icon="decision" />
          </div>
        ) : (
          <div
            key="full"
            className="anim-fade flex min-h-0 flex-1 flex-col"
            style={{ width }}
          >
            <div className="px-2 pt-2 pb-1 flex flex-col gap-1">
              <button
                type="button"
                onClick={() => {
                  actions.newChat();
                  actions.setMobileNav(false);
                }}
                className="ctl-primary h-8 w-full"
                aria-label="New chat"
              >
                <I n="plus" s={14} /> New chat
              </button>
              <button
                type="button"
                onClick={() => {
                  actions.navigateTo('/p');
                  actions.setMobileNav(false);
                }}
                className="ctl-ghost h-8 w-full justify-center"
                aria-label="Private chat"
              >
                <I n="lock" s={14} /> Private chat
              </button>
            </div>

            <div className="flex items-center gap-1 px-2 pb-1.5">
              <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] px-2">
                <I n="search" s={12} className="muted shrink-0" />
                <input
                  value={filterValue}
                  onChange={(e) => actions.setChatFilter(e.target.value)}
                  placeholder="Filter chats…"
                  aria-label="Filter chats"
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-[var(--text-3)]"
                />
              </div>
              <Tip label="New folder" side="bottom">
                <button
                  type="button"
                  aria-label="New folder"
                  onClick={() => actions.createFolder()}
                  className="ctl-icon size-7 shrink-0 border-transparent bg-transparent text-[var(--text-2)] hover:bg-[var(--sunken)]"
                >
                  <I n="folder-plus" s={14} />
                </button>
              </Tip>
            </div>

            <nav className="px-2 pb-1" aria-label="Index">
              <IndexItem to="/" label="Home" icon="home" />
              <IndexItem to="/notes" label="Notes" icon="note" />
              <IndexItem to="/decisions" label="Decisions" icon="decision" />
            </nav>

            <div className="sec-label px-3 pb-1">Chats</div>

            <ChatList items={chatItems} activeId={activeId} />
          </div>
        )}
      </div>

      {!inDrawer && !collapsed && (
        // biome-ignore lint/a11y/useSemanticElements: draggable splitter, not a thematic break
        <div
          ref={resizer}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onPointerDown={() => setDragging(true)}
          onDoubleClick={() => actions.setSidebarWidth(264)}
          className="absolute -right-0.5 top-0 z-20 h-full w-1 cursor-col-resize hover:bg-[var(--accent-weak)]"
          style={{ background: dragging ? 'var(--accent)' : undefined }}
        />
      )}
    </nav>
  );
}

function IndexItem({
  to,
  label,
  icon,
}: {
  to: LinkTo;
  label: string;
  icon: string;
}) {
  return (
    <Link
      to={to}
      onClick={() => actions.setMobileNav(false)}
      className="flex h-8 items-center gap-2.5 rounded-[7px] px-2.5 text-[14px] no-underline text-[var(--text)] hover:bg-[var(--sunken)]"
    >
      <I n={icon} s={15} className="shrink-0 text-[var(--text-3)]" />
      {label}
    </Link>
  );
}

function RailLink({
  to,
  label,
  icon,
}: {
  to: LinkTo;
  label: string;
  icon: string;
}) {
  return (
    <Tip label={label} side="bottom">
      <Link
        to={to}
        aria-label={label}
        className="ctl-icon border-transparent bg-transparent text-[var(--text-2)] hover:bg-[var(--sunken)]"
      >
        <I n={icon} s={15} />
      </Link>
    </Tip>
  );
}

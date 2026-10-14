/*
 * ArtifactSettings — settings page listing the artifacts the user has
 * published.
 *
 * Business logic:
 * - Loads the published list on mount and can reload it on demand; rows
 *   come newest first and the API only returns published ones, so nothing
 *   private is ever listed here.
 * - Each row links to the source chat and branch
 *   (/c/<chatId>?leaf=<leafId>) and to the frozen public copy at /a/<id>
 *   in a new tab, plus a Public/Private badge and the publish age.
 * - Copying the link is read-only: it never changes the published state.
 * - Making an artifact private is a danger confirm — the public link stops
 *   working but the row survives, so it can be published again later from
 *   the artifact panel, which is the only place that publishes.
 * - Removing is a danger confirm and deletes the row for good, taking the
 *   link with it; both failures surface as a toast.
 */
'use client';

import { useEffect, useState } from 'react';
import { Link } from 'waku/router/client';
import { timeAgo } from '../lib/format';
import { I } from '../lib/icons';
import { actions, usePublishedStore } from '../stores';
import { errorText } from '../stores/models';
import { IconButton } from '../ui/primitives';

/* the user's artifacts; each row links to the source chat and branch and shows
   whether it is public. copying a link never changes that state. */
export function ArtifactSettings() {
  const { items, status, error } = usePublishedStore();

  useEffect(() => {
    void actions.loadPublished();
  }, []);

  const makePrivate = async (id: number, title: string) => {
    const ok = await actions.confirm({
      title: `Make “${title}” private?`,
      body: 'Its public link will stop working. You can publish it again later.',
      confirmLabel: 'Make private',
      danger: true,
    });
    if (!ok) return;
    try {
      await actions.setPublished(id, false);
    } catch (e) {
      actions.toast(errorText(e), 'error');
    }
  };

  const remove = async (id: number, title: string) => {
    const ok = await actions.confirm({
      title: `Remove “${title}”?`,
      body: 'This deletes the public link for good. This can’t be undone.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await actions.remove(id);
    } catch (e) {
      actions.toast(errorText(e), 'error');
    }
  };

  const copyLink = async (id: number) => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/a/${id}`);
      actions.toast('Public link copied', 'info');
    } catch {
      actions.toast('Could not copy link', 'error');
    }
  };

  return (
    <section className="rounded-[8px] border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="mb-2 flex items-center gap-2">
        <div className="sec-label">Shared artifacts</div>
        {status === 'ready' && items.length > 0 && (
          <span className="num text-[11px] muted">{items.length}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            icon="retry"
            tip="Reload"
            ghost
            size={24}
            disabled={status === 'loading'}
            onClick={() => void actions.loadPublished()}
          />
        </div>
      </div>

      <p className="mb-2 text-[12px] muted">
        Artifacts you have published. Private artifacts stay hidden until you
        publish them from the artifact panel.
      </p>

      {status === 'error' && (
        <div className="mb-2 text-[12px] text-[var(--danger)]">{error}</div>
      )}
      {status === 'ready' && items.length === 0 && (
        <div className="text-[12px] muted">
          Nothing is public. Open an artifact and publish it to get a share
          link.
        </div>
      )}

      <div className="-mx-1 flex flex-col">
        {items.map((a) => (
          <div
            key={a.id}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[6px] p-2 text-[13px] hover:bg-[var(--sunken)]"
          >
            <I
              n={
                a.kind === 'code'
                  ? 'file'
                  : a.kind === 'markdown'
                    ? 'note'
                    : 'grid'
              }
              s={14}
              className="shrink-0 text-[var(--text-2)]"
            />
            <span className="min-w-0 flex-1 truncate">{a.title}</span>
            {a.chatId && (
              <Link
                to={`/c/${a.chatId}${a.leafId ? `?leaf=${a.leafId}` : ''}`}
                className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
              >
                <I n="chat" s={11} />
                {a.chatTitle ?? 'Chat'}
              </Link>
            )}
            <span
              className={`flex shrink-0 items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[11px] ${
                a.published
                  ? 'bg-[var(--accent-weak)] text-[var(--accent)]'
                  : 'bg-[var(--sunken)] muted'
              }`}
            >
              <I n={a.published ? 'globe' : 'lock'} s={11} />
              {a.published ? 'Public' : 'Private'}
            </span>
            <span className="num shrink-0 text-[11px] muted">
              {timeAgo(a.createdAt)}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <Link
                to={`/a/${a.id}`}
                target="_blank"
                className="ctl h-6 rounded-[5px] px-1.5 text-[11px]"
              >
                View
              </Link>
              <IconButton
                icon="link"
                tip="Copy public link"
                ghost
                size={24}
                onClick={() => void copyLink(a.id)}
              />
              {a.published ? (
                <IconButton
                  icon="lock"
                  tip="Make private"
                  ghost
                  size={24}
                  onClick={() => void makePrivate(a.id, a.title)}
                />
              ) : (
                <Link
                  to={
                    a.chatId
                      ? `/c/${a.chatId}${a.leafId ? `?leaf=${a.leafId}` : ''}`
                      : '/'
                  }
                  className="ctl h-6 rounded-[5px] px-1.5 text-[11px]"
                >
                  Publish
                </Link>
              )}
              <IconButton
                icon="trash"
                tip="Remove"
                ghost
                size={24}
                onClick={() => void remove(a.id, a.title)}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

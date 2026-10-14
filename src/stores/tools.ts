/*
 * ToolsStore — server-reported tool availability, keyed by tool id.
 *
 * Business logic:
 * - items maps ToolId → ToolStatus from GET /api/tools, fetched once
 *   during boot; the record is empty until it answers, so nothing is
 *   treated as unavailable before then.
 * - status runs idle → loading → ready/error: boot sets loading,
 *   setToolStatuses flips it to ready with the fetched list, and a failed
 *   fetch leaves 'error'. readiness only greys grants out, so it gates
 *   neither boot nor the stage.
 * - it reports capability, never the user's choices — the composer's tool
 *   bar and the /tools page fold these statuses into modelDisabledTools
 *   to grey a tool out, replace its description with the reason (no key,
 *   no backend configured), and effectiveGrants drops such a grant from
 *   the outgoing payload even if it is switched on.
 * - a status also lists the backends the tool actually offers, which is
 *   where the provider pickers hide the 'default' pseudo-provider and
 *   fall back when a stored pick is gone.
 * - no actions and no persistence: boot writes it, everyone else reads.
 */
'use client';

import { create } from 'zustand';
import type { ToolId, ToolStatus } from '../types';

type ToolsState = {
  /* empty until GET /api/tools answers; nothing is disabled before that */
  items: Record<ToolId, ToolStatus>;
  status: 'idle' | 'loading' | 'ready' | 'error';
};

export const useToolsStore = create<ToolsState>()(() => ({
  items: {},
  status: 'idle',
}));

export const setToolStatuses = (list: ToolStatus[]) =>
  useToolsStore.setState({
    items: Object.fromEntries(list.map((t) => [t.id, t])),
    status: 'ready',
  });

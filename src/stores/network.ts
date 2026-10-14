/*
 * NetworkStore — connection state, provider health, the offline send
 * queue and the dev flags every api call is threaded through.
 *
 * Business logic:
 * - this store has no actions of its own: boot.ts, send.ts and models.ts
 *   write it with setState, and it never persists anything.
 * - connection is derived, never set directly — boot's syncConn maps
 *   navigator.onLine or dev.simulateOffline to 'offline', dev.degraded to
 *   'degraded', else 'connected'. it drives the offline banner and the
 *   composer's "queued on reconnect" hint.
 * - queued holds the full outgoing payload of sends made while offline
 *   (parked there by beginSend, with the turn marked 'queued'); coming
 *   back online with a non-empty queue is the only trigger for
 *   sendActions.flushQueue(), which replays them and clears the list.
 * - providers and latencyMs come from GET /api/provider-health at boot
 *   and on reconnect; a 'rate_limited' provider feeds the rate-limit
 *   banner.
 * - dev defaults to every flag off and is session-only — the status bar's
 *   debugger toggles it through boot's setDev, and each flag makes the
 *   matching api call fail, stall or come back empty, so the designed
 *   states stay reachable from the UI.
 * - isOffline() is the single gate send.ts checks before hitting the
 *   network, so the simulated offline flag behaves like a real one.
 */
'use client';

import { create } from 'zustand';
import {
  type DevFlags,
  defaultDevFlags,
  type OutgoingMessage,
} from '../lib/api';
import type { ConnStatus, Provider } from '../types';

export type QueuedMessage = {
  chatId: string;
  msgId: string;
  payload: OutgoingMessage;
};

type NetworkState = {
  connection: ConnStatus;
  latencyMs: number;
  lastError: string | null;
  providers: Provider[];
  queued: QueuedMessage[];
  dev: DevFlags;
};

export const useNetworkStore = create<NetworkState>()(() => ({
  connection: 'connected',
  latencyMs: 0,
  lastError: null,
  providers: [],
  queued: [],
  dev: defaultDevFlags(),
}));

export const isOffline = (): boolean =>
  !navigator.onLine || useNetworkStore.getState().dev.simulateOffline;

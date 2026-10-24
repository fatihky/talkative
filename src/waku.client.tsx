/*
 * waku.client.tsx — the app's custom Waku client entry; Waku uses this
 * file instead of its built-in boot whenever src/waku.client.tsx exists.
 *
 * Business logic:
 * - It is a copy of Waku's default client boot with one addition:
 *   lib/crypto-polyfill is imported first so it evaluates before
 *   react/waku and everything downstream (better-auth, mermaid, …).
 *   The polyfill patches crypto.randomUUID, which browsers omit on
 *   insecure origins (plain-http LAN) even though getRandomValues
 *   works there.
 * - Boot rule (unchanged from the default): if SSR set
 *   __WAKU_HYDRATE__, hydrate the server-rendered document; otherwise
 *   mount the Router fresh, always under StrictMode.
 */
import './lib/crypto-polyfill';

import { createElement, StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { unstable_defaultRootOptions as defaultRootOptions } from 'waku/client';
import { Router } from 'waku/router/client';

const rootElement = createElement(StrictMode, null, createElement(Router));

if ((globalThis as { __WAKU_HYDRATE__?: boolean }).__WAKU_HYDRATE__) {
  hydrateRoot(document, rootElement, defaultRootOptions);
} else {
  createRoot(document, defaultRootOptions).render(rootElement);
}

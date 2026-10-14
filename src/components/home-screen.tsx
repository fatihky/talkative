/*
 * HomeScreen — the new-chat landing page.
 *
 * Business logic:
 * - Sets context to `new` and clears any pending folder on mount, so a
 *   chat started from home is unfiled; the folder screen opts back in.
 * - Leaves the composer to Stage and feeds it the app-wide banner list
 *   (offline, provider and catalog errors, context overflow).
 */
'use client';

import { useEffect } from 'react';
import { actions, useBanners } from '../stores';
import { setPendingFolder } from '../stores/draft';
import { Stage } from './stage';

export function HomeScreen() {
  useEffect(() => {
    actions.setContext('new');
    /* the home composer is unfiled; the folder screen opts back in */
    setPendingFolder(null);
  }, []);
  const banners = useBanners();
  return <Stage banners={banners} />;
}

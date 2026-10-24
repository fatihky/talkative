/* AppearancePage (/settings/appearance) — auth-gated theme and composer
   preferences, stored per user. */

import { AppearanceSettings } from '../../components/appearance-settings';
import { AuthGuard } from '../../components/auth-guard';
import { SettingsSubPage } from '../../components/settings-client';

export default async function AppearancePage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Appearance — Talkative</title>
        <SettingsSubPage title="Appearance">
          <AppearanceSettings />
        </SettingsSubPage>
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;

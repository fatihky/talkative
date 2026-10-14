/* AccountPage (/settings/account) — auth-gated: change your own password. */
import { AuthGuard } from '../../components/auth-guard';
import { PasswordSettings } from '../../components/password-settings';
import { SettingsSubPage } from '../../components/settings-client';

export default async function AccountPage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Account — Talkative</title>
        <SettingsSubPage title="Account">
          <PasswordSettings />
        </SettingsSubPage>
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;

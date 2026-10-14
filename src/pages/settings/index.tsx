/* SettingsPage (/settings) — auth-gated settings hub; the Admin group is
   listed only when /api/settings reports the user is an admin. */
import { AuthGuard } from '../../components/auth-guard';
import { SettingsClient } from '../../components/settings-client';

export default async function SettingsPage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Settings — Talkative</title>
        <SettingsClient />
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;

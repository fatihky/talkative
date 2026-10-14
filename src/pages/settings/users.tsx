/* UsersPage (/settings/users) — admin-only account management; the page
   guards on auth alone, so a non-admin who types the url gets an empty
   shell: /api/users 403s and the panel hides. */
import { AuthGuard } from '../../components/auth-guard';
import { SettingsSubPage } from '../../components/settings-client';
import { UserManagement } from '../../components/user-management';

export default async function UsersPage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Users — Talkative</title>
        <SettingsSubPage title="Users">
          <UserManagement />
        </SettingsSubPage>
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;

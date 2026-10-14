/* SitePage (/settings/site) — admin-only site settings (registration,
   env-key access); the page guards on auth alone, so a non-admin who types
   the url gets an empty shell: /api/settings 403s and the panel hides. */
import { AuthGuard } from '../../components/auth-guard';
import { SettingsSubPage } from '../../components/settings-client';
import { SiteSettings } from '../../components/site-settings';

export default async function SitePage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Site — Talkative</title>
        <SettingsSubPage title="Site">
          <SiteSettings />
        </SettingsSubPage>
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;

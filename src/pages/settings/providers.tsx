/* ProvidersPage (/settings/providers) — auth-gated: your provider
   connections and the merged model catalog on one page. */
import { AuthGuard } from '../../components/auth-guard';
import { ProvidersClient } from '../../components/providers-client';
import { SettingsSubPage } from '../../components/settings-client';

export default async function ProvidersPage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Providers & models — Talkative</title>
        <SettingsSubPage title="Providers & models">
          <ProvidersClient />
        </SettingsSubPage>
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;

/* ArtifactsPage (/settings/artifacts) — auth-gated: the artifacts you have
   published, with copy-link and take-offline actions. */
import { ArtifactSettings } from '../../components/artifact-settings';
import { AuthGuard } from '../../components/auth-guard';
import { SettingsSubPage } from '../../components/settings-client';

export default async function ArtifactsPage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Shared artifacts — Talkative</title>
        <SettingsSubPage title="Shared artifacts">
          <ArtifactSettings />
        </SettingsSubPage>
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;

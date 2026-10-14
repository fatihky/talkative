/* ToolsPage (/settings/tools) — auth-gated: account-wide default tool
   grants, providers and concurrency; per-chat picks stay in the composer. */
import { AuthGuard } from '../../components/auth-guard';
import { SettingsSubPage } from '../../components/settings-client';
import { ToolsClient } from '../../components/tools-client';

export default async function ToolsPage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Tools — Talkative</title>
        <SettingsSubPage title="Tools">
          <ToolsClient />
        </SettingsSubPage>
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;

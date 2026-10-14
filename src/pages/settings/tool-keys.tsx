/* ToolKeysPage (/settings/tool-keys) — auth-gated: your own tool-provider
   keys; environment keys show as "already set" and only admins see which var. */
import { AuthGuard } from '../../components/auth-guard';
import { SettingsSubPage } from '../../components/settings-client';
import { ToolCredentials } from '../../components/tool-credentials';

export default async function ToolKeysPage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Tool keys — Talkative</title>
        <SettingsSubPage title="Tool keys">
          <ToolCredentials />
        </SettingsSubPage>
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;
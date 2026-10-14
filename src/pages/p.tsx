/* PrivatePage (/p) — auth-gated unsaved chat; nothing is persisted. */
import { AuthGuard } from '../components/auth-guard';
import { PrivateScreen } from '../components/private-screen';

export default async function PrivatePage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Private chat — Talkative</title>
        <PrivateScreen />
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;

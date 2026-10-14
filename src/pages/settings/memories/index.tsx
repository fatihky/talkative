/* MemoriesPage (/settings/memories) — auth-gated list of the durable facts
   shared across your chats. */
import { AuthGuard } from '../../../components/auth-guard';
import { MemoriesClient } from '../../../components/memories-client';

export default async function MemoriesPage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Memories — Talkative</title>
        <MemoriesClient />
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;

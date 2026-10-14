/* ChatPage (/c/[slug]) — auth-gated thread; the slug is a chat id. */
import { AuthGuard } from '../../components/auth-guard';
import { ThreadScreen } from '../../components/thread';

export default async function ChatPage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Chat — Talkative</title>
        <ThreadScreen />
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;

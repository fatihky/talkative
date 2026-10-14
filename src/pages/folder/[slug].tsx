/* FolderPage (/folder/[slug]) — auth-gated folder view; a chat started
   here is filed into the folder on its first send. */
import { AuthGuard } from '../../components/auth-guard';
import { FolderScreen } from '../../components/folder-screen';

export default async function FolderPage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Folder — Talkative</title>
        <FolderScreen />
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;

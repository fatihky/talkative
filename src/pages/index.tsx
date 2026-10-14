/* HomePage (/) — auth-gated new-chat stage; guests go to /auth/login. */
import { AuthGuard } from '../components/auth-guard';
import { HomeScreen } from '../components/home-screen';

export default async function HomePage() {
  return (
    <AuthGuard>
      <div className="contents">
        <title>Talkative</title>
        <HomeScreen />
      </div>
    </AuthGuard>
  );
}

export const getConfig = async () => ({ render: 'dynamic' }) as const;

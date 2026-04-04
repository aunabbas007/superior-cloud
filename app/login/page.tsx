// PATH: app/login/page.tsx
// Server component wrapper — prevents static pre-rendering at build time.

export const dynamic = 'force-dynamic';

import LoginClient from './LoginClient';

export default function LoginPage() {
  return <LoginClient />;
}

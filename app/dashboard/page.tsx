// PATH: app/dashboard/page.tsx
// Server component wrapper.
// force-dynamic here prevents Next.js from statically pre-rendering
// this route at build time — the root cause of all deployment failures.
// The actual dashboard UI is in DashboardClient.tsx

export const dynamic = 'force-dynamic';

import DashboardClient from './DashboardClient';

export default function DashboardPage() {
  return <DashboardClient />;
}

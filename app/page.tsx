// PATH: app/page.tsx
// Root route — redirect immediately to /login.
// Without this, visiting localhost:3000 renders the default Next.js
// starter page briefly before the middleware or client-side code kicks in.
// This is the "white login page flash" seen before the real dark login.

import { redirect } from 'next/navigation';

export default function RootPage() {
  redirect('/login');
}

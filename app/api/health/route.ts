// PATH: app/api/health/route.ts
// Lightweight keepalive endpoint — pings Supabase to confirm it's awake.
// Called by dashboard on mount. If this fails → show "waking up" banner.

import { createClient } from '@supabase/supabase-js';
import { NextResponse }  from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    // Minimal query — just enough to confirm Supabase is responding
    const { error } = await supabase.from('files').select('id').limit(1);
    if (error) throw new Error(error.message);
    return NextResponse.json({ status: 'ok', ts: Date.now() });
  } catch (err: any) {
    return NextResponse.json({ status: 'error', message: err.message }, { status: 503 });
  }
}

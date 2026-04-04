// ─────────────────────────────────────────────────────────────────────────────
// SECURE AUTH HELPER
//
// THE VULNERABILITY WE'RE FIXING:
//   Old pattern: userId came from req.json() — trusted from browser.
//   Attack: attacker sends any victim's userId → reads their data.
//
// THE FIX:
//   Extract userId from the Authorization header (Supabase JWT Bearer token).
//   The JWT is signed by Supabase with a secret only Supabase knows.
//   We verify it server-side using supabase.auth.getUser(token).
//   Even if attacker knows victim's userId, they can't forge the JWT.
//   Only the real logged-in user has a valid JWT for their userId.
//
// USAGE in every API route:
//   const { userId, error } = await getVerifiedUserId(req);
//   if (error) return error;   // returns 401 response automatically
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from '@supabase/supabase-js';
import { NextResponse }  from 'next/server';

export async function getVerifiedUserId(req: Request): Promise<
  { userId: string; error: null } | { userId: null; error: NextResponse }
> {
  const authHeader = req.headers.get('Authorization');
  const token      = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return { userId: null, error: NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 }) };
  }

  // Use SERVICE ROLE key ONLY for token verification — never for data queries.
  // The service role key bypasses RLS but we only use it here to verify the JWT.
  // All data queries still use the anon key with explicit .eq('user_id', userId).
  const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !user) {
    return { userId: null, error: NextResponse.json({ error: 'Invalid or expired session. Please log in again.' }, { status: 401 }) };
  }

  return { userId: user.id, error: null };
}

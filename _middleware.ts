// PATH: middleware.ts  (project root — same level as next.config.ts)
//
// ═══════════════════════════════════════════════════════════════════════════
//  AUTH MIDDLEWARE — The definitive fix for the "flash then redirect" bug
//
//  WHY THIS IS THE RIGHT PLACE FOR AUTH GATING:
//
//  Previous attempts put auth gating inside client components (dashboard,
//  login). Client components run in the browser AFTER the page is already
//  rendered. Any auth check there has a window — however small — where the
//  wrong page is visible. That window is what causes the flash.
//
//  Middleware runs on the SERVER, BEFORE the response is sent.
//  The browser never receives HTML for a page the user shouldn't see.
//  No JavaScript executes. No React renders. No timing window. Zero flashes.
//
//  WHAT THIS DOES:
//    /dashboard (or any sub-path) + no valid session → redirect to /login
//    /login                       + valid session    → redirect to /dashboard
//    Everything else                                 → pass through
//
//  HOW IT READS THE SESSION:
//  Supabase @supabase/ssr stores the session in cookies.
//  createServerClient reads those cookies from the incoming request headers.
//  getUser() validates the JWT with Supabase's server (not just decoding it).
//  This is cryptographically secure — cannot be spoofed by a tampered cookie.
//
// ═══════════════════════════════════════════════════════════════════════════

import { createServerClient } from '@supabase/ssr';
import { NextResponse }       from 'next/server';
import type { NextRequest }   from 'next/server';

export async function middleware(request: NextRequest) {
  // We build the response object first so the cookie-setter can attach
  // refreshed auth cookies to it (Supabase may silently rotate the JWT).
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        // Read cookies from the incoming request
        getAll() {
          return request.cookies.getAll();
        },
        // Write refreshed cookies to both the request (for this middleware
        // execution) and the response (so the browser receives them)
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value }: { name: string; value: string }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }: { name: string; value: string; options?: Record<string, unknown> }) =>
            response.cookies.set(name, value, options as any)
          );
        },
      },
    }
  );

  // getUser() makes a server-side call to Supabase to validate the JWT.
  // This is more secure than getSession() which only reads the local cookie.
  // If the token was tampered with or expired, getUser() returns null.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // ── Rule 1: Protected routes ───────────────────────────────────────────
  // If the user is NOT authenticated and tries to access /dashboard,
  // redirect them to /login immediately — server-side, no flash.
  if (!user && pathname.startsWith('/dashboard')) {
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  // ── Rule 2: Redirect logged-in users away from login ──────────────────
  // If the user IS authenticated and visits /login, skip the login page
  // entirely and send them straight to /dashboard.
  if (user && pathname === '/login') {
    const dashboardUrl = new URL('/dashboard', request.url);
    return NextResponse.redirect(dashboardUrl);
  }

  // ── Pass through ──────────────────────────────────────────────────────
  // All other routes proceed normally. The response may carry refreshed
  // auth cookies from the setAll() call above.
  return response;
}

// Only run middleware on these paths — skip static files, images, API routes.
export const config = {
  matcher: [
    '/dashboard/:path*',
    '/login',
  ],
};

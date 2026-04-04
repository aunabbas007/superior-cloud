'use client';
// PATH: app/login/page.tsx
//
// ═══════════════════════════════════════════════════════════════════════════
//  LOGIN PAGE — Simplified after middleware takes over auth gating
//
//  WHAT CHANGED (and why):
//
//  OLD pattern (broken):
//    signInWithPassword()
//    → subscribe to onAuthStateChange
//    → wait for SIGNED_IN event
//    → router.push('/dashboard')
//    Problem: The SIGNED_IN event fires on the LOGIN page's client instance.
//    The DASHBOARD's module-level client is a different instance. When the
//    dashboard mounts, its own getSession() + a 200ms re-check timer ran.
//    If getSession() returned null during that 200ms window, the timer fired
//    and sent the user back to /login — the "flash then kick" bug.
//
//  NEW pattern (fixed):
//    signInWithPassword()
//    → router.push('/dashboard')    ← navigate immediately, session is in cookie
//    → router.refresh()             ← forces Next.js to re-run middleware with
//                                      the new auth cookie server-side
//    middleware.ts intercepts the /dashboard request, validates the cookie,
//    and serves the page. No client JavaScript involved. No race. No flash.
//
//  router.refresh() is essential — without it Next.js uses the pre-login
//  cached server state and middleware sees the old (no-session) cookie.
//
// ═══════════════════════════════════════════════════════════════════════════

import { useState }            from 'react';
import { createBrowserClient } from '@supabase/ssr';
import { useRouter }           from 'next/navigation';

// Singleton at module scope — not inside the component.
const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function LoginPage() {
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const [mode,     setMode]     = useState<'signin' | 'signup'>('signin');
  const [signupOk, setSignupOk] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    // ── Sign Up ───────────────────────────────────────────────────────────
    if (mode === 'signup') {
      const { error: signUpError } = await supabase.auth.signUp({ email, password });
      if (signUpError) {
        setError(signUpError.message);
        setLoading(false);
        return;
      }
      setSignupOk(true);
      setLoading(false);
      return;
    }

    // ── Sign In ───────────────────────────────────────────────────────────
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      setError(signInError.message);
      setLoading(false);
      return;
    }

    // Session is now written to cookies by @supabase/ssr.
    // Navigate immediately — middleware.ts handles the server-side auth check.
    // router.refresh() forces Next.js to pick up the new cookie server-side.
    // We do NOT call setLoading(false) — the spinner stays while navigating,
    // giving the user clear feedback that something is happening.
    router.push('/dashboard');
    router.refresh();
  };

  // ── Sign Up success screen ────────────────────────────────────────────────
  if (signupOk) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ background: '#080B12' }}>
        <div className="text-center px-8 py-10 rounded-2xl border border-white/10 bg-white/5 max-w-sm w-full mx-4">
          <div className="text-4xl mb-4">📧</div>
          <h2 className="text-white font-bold text-lg mb-2">Check your email</h2>
          <p className="text-gray-400 text-sm mb-1">We sent a confirmation link to</p>
          <p className="text-blue-400 text-sm font-medium mb-6">{email}</p>
          <p className="text-gray-500 text-xs mb-6">
            Click the link to activate your account, then come back and sign in.
          </p>
          <button
            onClick={() => { setSignupOk(false); setMode('signin'); }}
            className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
          >
            ← Back to Sign In
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center" style={{ background: '#080B12' }}>

      {/* Ambient glow */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div
          className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full opacity-[0.07]"
          style={{ background: 'radial-gradient(circle, #2563eb 0%, transparent 70%)' }}
        />
      </div>

      <div
        className="relative w-full max-w-sm mx-4 px-8 py-10 rounded-3xl border border-white/8"
        style={{
          background:     'rgba(13,17,23,0.97)',
          backdropFilter: 'blur(20px)',
          boxShadow:      '0 25px 80px rgba(0,0,0,0.6)',
        }}
      >
        {/* Logo */}
        <div className="text-center mb-8">
          <div
            className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-4"
            style={{
              background: 'linear-gradient(135deg,#1d4ed8,#0891b2)',
              boxShadow:  '0 8px 24px rgba(37,99,235,0.35)',
            }}
          >
            <svg width="26" height="26" fill="none" stroke="white" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z"
              />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-white tracking-tight">Superior Cloud</h1>
          <p className="text-[10px] text-gray-600 mt-1 uppercase tracking-[0.2em]">Intelligence</p>
        </div>

        {/* Mode tabs */}
        <div className="flex bg-white/4 rounded-xl p-1 mb-6 border border-white/5">
          {(['signin', 'signup'] as const).map(m => (
            <button
              key={m}
              onClick={() => { setMode(m); setError(''); }}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-all ${
                mode === m
                  ? 'bg-blue-600 text-white shadow-lg'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {m === 'signin' ? 'Sign In' : 'Sign Up'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[11px] font-semibold text-gray-500 mb-1.5 uppercase tracking-wider">
              Email
            </label>
            <input
              type="email" required
              value={email} onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full px-4 py-3 rounded-xl text-sm text-white placeholder-gray-700 border border-white/8 focus:border-blue-500/50 focus:outline-none transition-all"
              style={{ background: 'rgba(255,255,255,0.04)' }}
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-gray-500 mb-1.5 uppercase tracking-wider">
              Password
            </label>
            <input
              type="password" required
              value={password} onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-4 py-3 rounded-xl text-sm text-white placeholder-gray-700 border border-white/8 focus:border-blue-500/50 focus:outline-none transition-all"
              style={{ background: 'rgba(255,255,255,0.04)' }}
            />
          </div>

          {error && (
            <div
              className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl border"
              style={{ background: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.2)' }}
            >
              <span className="text-red-400 text-sm leading-none mt-0.5">⚠️</span>
              <span className="text-red-400 text-xs leading-relaxed">{error}</span>
            </div>
          )}

          <button
            type="submit" disabled={loading}
            className="w-full py-3.5 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-60 disabled:cursor-not-allowed mt-2"
            style={{
              background: 'linear-gradient(135deg,#2563eb,#0891b2)',
              boxShadow:  loading ? 'none' : '0 4px 20px rgba(37,99,235,0.3)',
            }}
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2.5">
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="white" strokeWidth="4"/>
                  <path className="opacity-75" fill="white" d="M4 12a8 8 0 018-8v8z"/>
                </svg>
                {mode === 'signin' ? 'Signing in…' : 'Creating account…'}
              </span>
            ) : (
              mode === 'signin' ? 'Sign In →' : 'Create Account →'
            )}
          </button>
        </form>

        <p className="text-center text-[9px] text-gray-700 mt-8 tracking-wide">
          SECURED BY SUPABASE · GROQ · VOYAGE AI
        </p>
      </div>
    </div>
  );
}

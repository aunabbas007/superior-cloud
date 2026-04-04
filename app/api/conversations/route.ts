// PATH: app/api/conversations/route.ts
// Persists chat history across page refreshes.
// GET: load last 40 messages for this user (reverse chrono, then reversed for display)
// POST: save a user+assistant message pair after stream completes
// DELETE: clear all conversation history for this user

import { createClient }      from '@supabase/supabase-js';
import { getVerifiedUserId } from '@/lib/auth';
import { NextResponse }      from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  try {
    const { userId, error: authError } = await getVerifiedUserId(req);
    if (authError) return authError;

    const { data, error } = await supabase
      .from('conversations')
      .select('id, role, content, metadata, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(40);

    if (error) throw new Error(error.message);

    // Reverse so oldest is first (chronological display order)
    const messages = (data || []).reverse().map(m => ({
      role:       m.role,
      content:    m.content,
      isSynthesis: m.metadata?.isSynthesis ?? false,
    }));

    return NextResponse.json({ messages });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  try {
    const { userId, error: authError } = await getVerifiedUserId(req);
    if (authError) return authError;

    const { messages } = await req.json() as {
      messages: { role: 'user' | 'assistant'; content: string; isSynthesis?: boolean }[];
    };

    if (!messages?.length)
      return NextResponse.json({ error: 'No messages provided' }, { status: 400 });

    const rows = messages.map(m => ({
      user_id:  userId,
      role:     m.role,
      content:  m.content,
      metadata: m.isSynthesis ? { isSynthesis: true } : {},
    }));

    const { error } = await supabase.from('conversations').insert(rows);
    if (error) throw new Error(error.message);

    // Keep only the last 100 messages per user (rolling window)
    const { data: all } = await supabase
      .from('conversations')
      .select('id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (all && all.length > 100) {
      const toDelete = all.slice(100).map((r: any) => r.id);
      await supabase.from('conversations').delete().in('id', toDelete);
    }

    return NextResponse.json({ success: true, saved: rows.length });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  try {
    const { userId, error: authError } = await getVerifiedUserId(req);
    if (authError) return authError;

    const { error } = await supabase
      .from('conversations')
      .delete()
      .eq('user_id', userId);

    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

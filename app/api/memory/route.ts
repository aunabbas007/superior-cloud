import { createClient }      from '@supabase/supabase-js';
import { getVerifiedUserId } from '@/lib/auth';
import { NextResponse }  from 'next/server';
import { Groq }          from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

// ─────────────────────────────────────────────────────────────────────────────
// MEMORY API
//
// HOW IT WORKS — same principle as how I (Claude) maintain context:
//   Episodic memory compression. After each conversation, take the raw turns,
//   compress them into a tiny bullet-point "fact sheet" about this user.
//   On next session, inject that fact sheet into the system prompt so the AI
//   "remembers" without having to re-read entire past conversations.
//
//   Old conversation (1000 tokens) → compressed memory (50-80 tokens)
//   This keeps the context window lean while preserving personality + history.
//
// GET  /api/memory?userId=xxx   → { memory: string }
// POST /api/memory              → { success: true, factCount: number }
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const { userId, error: authError } = await getVerifiedUserId(req);
  if (authError) return authError;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data } = await supabase
    .from('user_memory')
    .select('memory_text, fact_count, last_updated')
    .eq('user_id', userId)
    .maybeSingle();

  return NextResponse.json({
    memory:      data?.memory_text  ?? '',
    factCount:   data?.fact_count   ?? 0,
    lastUpdated: data?.last_updated ?? null,
  });
}

export async function POST(req: Request) {
  try {
    // Memory POST is called server-to-server from the chat route (which already
    // verified the user via JWT). We accept userId directly from the request body.
    // For browser calls, we fall back to JWT verification.
    const body = await req.json();
    const { conversation, userId: bodyUserId } = body;

    let userId: string;
    if (bodyUserId) {
      // Internal server-to-server call — trust the userId from body
      userId = bodyUserId;
    } else {
      // Browser call — verify JWT
      const { userId: jwtUserId, error: authError } = await getVerifiedUserId(req);
      if (authError) return authError;
      userId = jwtUserId as string;
    }

    if (!conversation?.length) return NextResponse.json({ success: false, reason: 'nothing to save' });

    const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

    // ── Load existing memory to merge with ────────────────────────────────────
    const { data: existing } = await supabase
      .from('user_memory')
      .select('memory_text')
      .eq('user_id', userId)
      .maybeSingle();

    const existingMemory = existing?.memory_text ?? '';

    // ── Format conversation for compression ───────────────────────────────────
    const convText = conversation
      .map((m: { role: string; content: string }) =>
        `${m.role === 'user' ? 'USER' : 'AI'}: ${m.content.slice(0, 300)}`
      ).join('\n');

    // ── Compress with llama-3.1-8b-instant ────────────────────────────────────
    // Using 8b-instant for this task: it's fast, costs nothing, and compression
    // doesn't need 70B intelligence — just pattern extraction.
    const response = await groq.chat.completions.create({
      model:       'llama-3.1-8b-instant',
      temperature: 0.1,
      max_tokens:  400,
      messages: [
        {
          role:    'system',
          content: `You extract and maintain user facts from conversations. You will receive:
1. EXISTING MEMORY — previously extracted facts about this user
2. NEW CONVERSATION — the latest exchange to analyze

Your job: Output an updated, deduplicated fact list. Each line starts with "•".
Extract ONLY real facts: name, job, goals, files they care about, questions they ask often,
preferences, important dates mentioned, topics they study.

RULES:
- Max 15 bullet points total
- Each bullet ≤ 15 words
- Deduplicate — if fact already in memory, don't repeat it
- Remove outdated facts if contradicted by new conversation
- Ignore greetings, generic questions, and small talk
- If nothing meaningful to extract, return the existing memory unchanged
- Output ONLY the bullet list — no preamble, no explanation`
        },
        {
          role:    'user',
          content: `EXISTING MEMORY:\n${existingMemory || '(none yet)'}\n\nNEW CONVERSATION:\n${convText}`
        }
      ],
    });

    const newMemory = response.choices[0]?.message?.content?.trim() ?? '';
    if (!newMemory) return NextResponse.json({ success: false, reason: 'empty compression result' });

    const factCount = (newMemory.match(/^•/gm) || []).length;

    // ── Upsert — one row per user ──────────────────────────────────────────────
    const { error } = await supabase
      .from('user_memory')
      .upsert({
        user_id:      userId,
        memory_text:  newMemory,
        fact_count:   factCount,
        last_updated: new Date().toISOString(),
      }, { onConflict: 'user_id' });

    if (error) {
      console.error('Memory save error:', error.message);
      return NextResponse.json({ success: false, reason: error.message });
    }

    console.log(`🧠 Memory updated for user: ${factCount} facts`);
    return NextResponse.json({ success: true, factCount });

  } catch (e: any) {
    console.error('Memory API error:', e.message);
    return NextResponse.json({ success: false, reason: e.message });
  }
}

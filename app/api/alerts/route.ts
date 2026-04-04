import { createClient }      from '@supabase/supabase-js';
import { getVerifiedUserId } from '@/lib/auth';
import { NextResponse }  from 'next/server';
import { Groq }          from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

// ─────────────────────────────────────────────────────────────────────────────
// ALERTS / PROACTIVE INTELLIGENCE API
//
// No other cloud storage does this. Google Drive, Dropbox — completely passive.
// You upload a document, they store it. That's it.
//
// Superior Cloud reads your documents and TELLS YOU what matters:
//   "Your Aadhaar card address hasn't been updated in 3 years"
//   "Your driving licence expires in 45 days"
//   "Your insurance policy renewal is due March 2025"
//   "Your resume mentions a certification expiring soon"
//
// GET  /api/alerts?userId=xxx         → { alerts, unreadCount }
// POST /api/alerts  { userId }        → scan all files → generate alerts
// PATCH /api/alerts { alertId, userId } → mark as read
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const { userId, error: authError } = await getVerifiedUserId(req);
  if (authError) return authError;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: alerts, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const unreadCount = (alerts || []).filter(a => !a.is_read).length;
  return NextResponse.json({ alerts: alerts || [], unreadCount });
}

export async function POST(req: Request) {
  try {
    const { userId, error: authError } = await getVerifiedUserId(req);
    if (authError) return authError;

    const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

    const now = new Date();

    // ── Fetch files that are worth scanning (documents/IDs, not images) ───────
    const { data: files } = await supabase
      .from('files')
      .select('id, name, category, created_at')
      .eq('user_id', userId)
      .in('category', [
        'Government ID', 'Financial Document', 'Certificate', 'Medical Record',
        'Legal Document', 'Business Document', 'Resume & Profile', 'Ticket & Booking'
      ]);

    if (!files || files.length === 0) {
      return NextResponse.json({ generated: 0, message: 'No scannable files found' });
    }

    // ── Check which files have already been alerted recently (avoid duplicates) ─
    const { data: existingAlerts } = await supabase
      .from('notifications')
      .select('file_id')
      .eq('user_id', userId)
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()); // last 7 days

    const recentlyAlertedFileIds = new Set((existingAlerts || []).map(a => a.file_id));
    const filesToScan = files.filter(f => !recentlyAlertedFileIds.has(f.id));

    if (filesToScan.length === 0) {
      return NextResponse.json({ generated: 0, message: 'All files checked recently' });
    }

    console.log(`🔔 Scanning ${filesToScan.length} files for alerts...`);

    let generated = 0;

    for (const file of filesToScan.slice(0, 10)) { // max 10 at a time to respect rate limits
      try {
        // ── Fetch first few chunks of this file ────────────────────────────────
        const { data: chunks } = await supabase
          .from('documents')
          .select('content')
          .eq('file_id', file.id)
          .limit(5);

        if (!chunks || chunks.length === 0) continue;

        const fileText = chunks.map(c => c.content).join('\n').slice(0, 2000);

        // ── Ask LLM to find important dates and actionable info ─────────────────
        const dateStr = now.toLocaleDateString('en-IN', {
          year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Kolkata'
        });

        const alertResponse = await groq.chat.completions.create({
          model:       'llama-3.1-8b-instant',
          temperature: 0.1,
          max_tokens:  300,
          messages: [
            {
              role:    'system',
              content: `You scan documents and extract actionable alerts. Today is ${dateStr}.

Look for:
- Expiry dates, validity periods, renewal dates
- Deadlines, due dates, important upcoming dates
- Missing information that could be problematic (e.g. unsigned contracts, expired IDs)
- Action items the user should know about

Return a JSON object:
{
  "hasAlert": true or false,
  "type": "expiry" or "insight" or "action_needed",
  "title": "short alert title (max 8 words)",
  "message": "clear helpful message (max 30 words)",
  "dueDate": "YYYY-MM-DD if applicable, else null",
  "priority": "critical" or "high" or "normal" or "low"
}

If nothing actionable found, return: {"hasAlert": false}
Return ONLY the JSON object — no markdown, no explanation.`
            },
            {
              role:    'user',
              content: `File: "${file.name}" (Category: ${file.category})\n\nContent:\n${fileText}`
            }
          ],
          response_format: { type: 'json_object' },
        });

        const raw    = alertResponse.choices[0]?.message?.content ?? '{}';
        const result = JSON.parse(raw);

        if (result.hasAlert) {
          await supabase.from('notifications').insert({
            user_id:  userId,
            file_id:  file.id,
            type:     result.type     || 'insight',
            title:    result.title    || 'File Alert',
            message:  result.message  || 'Check this file.',
            due_date: result.dueDate  || null,
            priority: result.priority || 'normal',
            is_read:  false,
          });
          generated++;
          console.log(`   ✅ Alert generated for "${file.name}": ${result.title}`);
        }

        // Small delay to avoid rate limiting on 8b-instant
        await new Promise(r => setTimeout(r, 500));

      } catch (fileErr: any) {
        console.warn(`   ⚠️  Alert scan failed for "${file.name}": ${fileErr.message}`);
      }
    }

    return NextResponse.json({ generated, scanned: filesToScan.length });

  } catch (e: any) {
    console.error('Alerts API error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const { alertId, markAllRead } = await req.json();
    const { userId, error: authError } = await getVerifiedUserId(req);
    if (authError) return authError;

    const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

    if (markAllRead) {
      await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('user_id', userId);
    } else if (alertId) {
      await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('id', alertId)
        .eq('user_id', userId);
    }

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

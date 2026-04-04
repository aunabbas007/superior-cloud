// PATH: app/api/timeline/route.ts
// Builds a personal timeline by extracting dates from indexed document content.
// No new AI calls — uses already-indexed text in the documents table.
// Groups events by year → month → file, returns structured timeline.

import { createClient }      from '@supabase/supabase-js';
import { getVerifiedUserId } from '@/lib/auth';
import { NextResponse }      from 'next/server';

// Date patterns to extract from text
// Covers: DD/MM/YYYY, DD-MM-YYYY, Month DD YYYY, DD Month YYYY, YYYY-MM-DD
const DATE_PATTERNS = [
  // ISO: 2024-03-15
  /\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g,
  // DD/MM/YYYY or DD-MM-YYYY
  /\b(0[1-9]|[12]\d|3[01])[\/\-](0[1-9]|1[0-2])[\/\-](20\d{2})\b/g,
  // Month DD, YYYY (January 15, 2024)
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/gi,
  // DD Month YYYY (15 January 2024)
  /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/gi,
  // Short month: Jan 2024, Feb 2024
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\s\-]+(20\d{2})\b/gi,
];

const MONTH_MAP: Record<string, number> = {
  january:1,february:2,march:3,april:4,may:5,june:6,
  july:7,august:8,september:9,october:10,november:11,december:12,
  jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
};

function parseDate(match: RegExpMatchArray, patternIdx: number): Date | null {
  try {
    let year: number, month: number, day: number;

    if (patternIdx === 0) {
      // ISO: 2024-03-15
      [, year, month, day] = match.map(Number) as any;
    } else if (patternIdx === 1) {
      // DD/MM/YYYY
      day = parseInt(match[1]); month = parseInt(match[2]); year = parseInt(match[3]);
    } else if (patternIdx === 2) {
      // Month DD, YYYY
      month = MONTH_MAP[match[1].toLowerCase()]; day = parseInt(match[2]); year = parseInt(match[3]);
    } else if (patternIdx === 3) {
      // DD Month YYYY
      day = parseInt(match[1]); month = MONTH_MAP[match[2].toLowerCase()]; year = parseInt(match[3]);
    } else {
      // Short month: Jan 2024
      month = MONTH_MAP[match[1].toLowerCase()]; year = parseInt(match[2]); day = 1;
    }

    if (!year || !month || year < 1990 || year > 2035) return null;
    return new Date(year, (month || 1) - 1, day || 1);
  } catch { return null; }
}

interface TimelineEvent {
  fileId:    string;
  fileName:  string;
  category:  string;
  date:      string;  // ISO
  year:      number;
  month:     number;
  snippet:   string;  // context around the date
  type:      string;  // inferred event type
}

function inferEventType(category: string, snippet: string): string {
  const s = snippet.toLowerCase();
  if (category === 'Travel Ticket')      return 'travel';
  if (category === 'Certificate')        return 'achievement';
  if (category === 'Medical Record')     return 'health';
  if (category === 'Salary & Pay Slip')  return 'payroll';
  if (category === 'Bank Statement')     return 'financial';
  if (category === 'Tax Document')       return 'tax';
  if (category === 'Government ID')      return 'identity';
  if (category === 'University Report')  return 'education';
  if (category === 'Research Paper')     return 'education';
  if (category === 'Receipt & Invoice')  return 'purchase';
  if (s.includes('join') || s.includes('appointment') || s.includes('joining')) return 'career';
  if (s.includes('birth') || s.includes('born'))                                return 'personal';
  if (s.includes('admit') || s.includes('admission'))                           return 'education';
  return 'document';
}

export async function GET(req: Request) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  try {
    const { userId, error: authError } = await getVerifiedUserId(req);
    if (authError) return authError;

    // Get all files for this user with their categories
    const { data: userFiles, error: filesErr } = await supabase
      .from('files')
      .select('id, name, category')
      .eq('user_id', userId)
      .eq('is_archived', false);

    if (filesErr) throw new Error(filesErr.message);
    if (!userFiles?.length) return NextResponse.json({ events: [], years: [] });

    const fileIds    = userFiles.map(f => f.id);
    const fileMap    = new Map(userFiles.map(f => [f.id, f]));

    // Fetch first 3 chunks per file (most dates appear in headers/first pages)
    const { data: chunks, error: chunksErr } = await supabase
      .from('documents')
      .select('file_id, content, chunk_index')
      .in('file_id', fileIds)
      .lte('chunk_index', 3)
      .order('chunk_index', { ascending: true });

    if (chunksErr) throw new Error(chunksErr.message);

    // Group chunks by file
    const chunksByFile = new Map<string, string>();
    for (const chunk of chunks || []) {
      const existing = chunksByFile.get(chunk.file_id) || '';
      chunksByFile.set(chunk.file_id, existing + ' ' + chunk.content);
    }

    const events: TimelineEvent[] = [];
    const seenFileIds = new Set<string>();

    for (const [fileId, text] of chunksByFile.entries()) {
      if (seenFileIds.has(fileId)) continue;
      const file = fileMap.get(fileId);
      if (!file) continue;

      // Try each date pattern
      for (let pi = 0; pi < DATE_PATTERNS.length; pi++) {
        const pattern = new RegExp(DATE_PATTERNS[pi].source, DATE_PATTERNS[pi].flags);
        let match: RegExpMatchArray | null;
        let found = false;

        while ((match = pattern.exec(text)) !== null) {
          const date = parseDate(match, pi);
          if (!date) continue;

          // Extract a small snippet around the match for context
          const start   = Math.max(0, match.index! - 60);
          const end     = Math.min(text.length, match.index! + 80);
          const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();

          events.push({
            fileId,
            fileName:  file.name,
            category:  file.category,
            date:      date.toISOString(),
            year:      date.getFullYear(),
            month:     date.getMonth() + 1,
            snippet:   snippet.slice(0, 120),
            type:      inferEventType(file.category, snippet),
          });

          seenFileIds.add(fileId);
          found = true;
          break; // One date per file
        }
        if (found) break;
      }
    }

    // Sort by date descending
    events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // Group by year for the frontend
    const byYear: Record<number, TimelineEvent[]> = {};
    for (const e of events) {
      if (!byYear[e.year]) byYear[e.year] = [];
      byYear[e.year].push(e);
    }

    const years = Object.keys(byYear).map(Number).sort((a, b) => b - a);

    return NextResponse.json({ events, byYear, years, total: events.length });

  } catch (err: any) {
    console.error('Timeline error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

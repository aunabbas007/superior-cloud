export const dynamic = 'force-dynamic'
// PATH: app/api/sensitivity/route.ts
// Scans all user files for PII (Personally Identifiable Information).
// Uses regex patterns on already-indexed document text — no new AI calls.
// Returns per-file sensitivity level: HIGH / MEDIUM / LOW
// Results are cached in sensitivity_flags table.

import { createClient }      from '@supabase/supabase-js';
import { getVerifiedUserId } from '@/lib/auth';
import { NextResponse }      from 'next/server';

// ── PII Detection Patterns ────────────────────────────────────────────────
const PII_PATTERNS: { type: string; pattern: RegExp; weight: number }[] = [
  // Indian Government IDs
  { type: 'aadhaar',   pattern: /\b\d{4}\s\d{4}\s\d{4}\b/g,          weight: 3 },
  { type: 'pan',       pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g,           weight: 3 },
  { type: 'voter_id',  pattern: /\b[A-Z]{3}\d{7}\b/g,                 weight: 2 },
  // Financial
  { type: 'bank_acc',  pattern: /\b\d{9,18}\b/g,                      weight: 2 },
  { type: 'ifsc',      pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,         weight: 2 },
  { type: 'card_no',   pattern: /\b\d{4}[\s\-]\d{4}[\s\-]\d{4}[\s\-]\d{4}\b/g, weight: 3 },
  // Contact
  { type: 'phone',     pattern: /\b(\+91[\s\-]?)?[6-9]\d{9}\b/g,     weight: 1 },
  { type: 'email',     pattern: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g, weight: 1 },
  // Passport
  { type: 'passport',  pattern: /\b[A-Z][1-9]\d{7}\b/g,              weight: 3 },
  // Medical (broad)
  { type: 'patient_id',pattern: /\bpatient[\s\-]?id[\s:\-]+\w+\b/gi, weight: 2 },
  // GST
  { type: 'gstin',     pattern: /\b\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1}\b/g, weight: 2 },
];

function detectPII(text: string): { types: string[]; score: number } {
  const found  = new Set<string>();
  let   score  = 0;

  for (const { type, pattern, weight } of PII_PATTERNS) {
    const p = new RegExp(pattern.source, pattern.flags);
    if (p.test(text)) {
      found.add(type);
      score += weight;
    }
  }

  return { types: [...found], score };
}

function scoreToLevel(score: number): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (score >= 4) return 'HIGH';
  if (score >= 1) return 'MEDIUM';
  return 'LOW';
}

export async function POST(req: Request) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  try {
    const { userId, error: authError } = await getVerifiedUserId(req);
    if (authError) return authError;

    // Get all non-archived files
    const { data: files, error: filesErr } = await supabase
      .from('files')
      .select('id, name, category')
      .eq('user_id', userId)
      .eq('is_archived', false);

    if (filesErr) throw new Error(filesErr.message);
    if (!files?.length) return NextResponse.json({ results: [], total: 0 });

    const fileIds = files.map(f => f.id);

    // Fetch document text chunks
    const { data: chunks, error: chunksErr } = await supabase
      .from('documents')
      .select('file_id, content')
      .in('file_id', fileIds);

    if (chunksErr) throw new Error(chunksErr.message);

    // Group text by file
    const textByFile = new Map<string, string>();
    for (const chunk of chunks || []) {
      textByFile.set(chunk.file_id, (textByFile.get(chunk.file_id) || '') + ' ' + chunk.content);
    }

    const results: {
      fileId:      string;
      fileName:    string;
      category:    string;
      sensitivity: 'HIGH' | 'MEDIUM' | 'LOW';
      piiTypes:    string[];
      piiCount:    number;
    }[] = [];

    const upsertRows = [];

    for (const file of files) {
      const text = textByFile.get(file.id) || '';
      const { types, score } = detectPII(text);
      const sensitivity = scoreToLevel(score);

      results.push({
        fileId:      file.id,
        fileName:    file.name,
        category:    file.category,
        sensitivity,
        piiTypes:    types,
        piiCount:    types.length,
      });

      upsertRows.push({
        file_id:     file.id,
        user_id:     userId,
        sensitivity,
        pii_types:   types,
        pii_count:   types.length,
        scanned_at:  new Date().toISOString(),
      });
    }

    // Cache results
    if (upsertRows.length > 0) {
      await supabase.from('sensitivity_flags').upsert(upsertRows, { onConflict: 'file_id' });
    }

    // Sort: HIGH first, then MEDIUM, then LOW
    const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    results.sort((a, b) => order[a.sensitivity] - order[b.sensitivity]);

    const summary = {
      high:   results.filter(r => r.sensitivity === 'HIGH').length,
      medium: results.filter(r => r.sensitivity === 'MEDIUM').length,
      low:    results.filter(r => r.sensitivity === 'LOW').length,
    };

    return NextResponse.json({ results, summary, total: results.length });

  } catch (err: any) {
    console.error('Sensitivity scan error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}


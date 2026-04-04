export const dynamic = 'force-dynamic'
// PATH: app/api/files/semantic-dupes/route.ts
//
// Finds near-duplicate files using two signals:
//
//  1. SEMANTIC (embedding cosine similarity > 0.82)
//     Fetches the first chunk embedding (chunk_index=0) for each file.
//     Computes pairwise cosine similarity in Node.js.
//     Voyage-3 embeddings are 1024-dimensional. For 50 files:
//     1225 pairs × 1024 ops ≈ 1.25M operations → ~30ms. Fast enough.
//
//  2. FILENAME (Levenshtein distance ≤ 3 on the base name)
//     Catches "resume_v1.pdf" vs "resume_v2.pdf" which may have
//     diverged content but are clearly the same document family.
//
// Returns pairs sorted by similarity descending.
// SHA-256 exact duplicates are already handled at upload time —
// this catches the near-duplicates that slipped through.

import { createClient }      from '@supabase/supabase-js';
import { getVerifiedUserId } from '@/lib/auth';
import { NextResponse }      from 'next/server';

// ── Cosine similarity between two float arrays ────────────────────────────
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ── Levenshtein distance between two strings (for filename comparison) ────
function levenshtein(s: string, t: string): number {
  const m = s.length, n = t.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = s[i - 1] === t[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function baseName(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')           // strip extension
    .toLowerCase()
    .replace(/[_\-\s]+/g, ' ')         // normalise separators
    .replace(/\s*v?\d+\.?\d*\s*$/, '') // strip trailing version numbers
    .replace(/\s*(final|copy|draft|new|old|backup|bak)\s*/g, '')
    .trim();
}

export async function POST(req: Request) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  try {
    const { userId, error: authError } = await getVerifiedUserId(req);
    if (authError) return authError;

    console.log(`\n🔍 SEMANTIC DUPE SCAN [user: ${userId}]`);

    // ── 1. Get all files for this user ────────────────────────────────────
    const { data: userFiles, error: filesErr } = await supabase
      .from('files')
      .select('id, name, category, size, created_at, type')
      .eq('user_id', userId)
      .eq('is_archived', false);

    if (filesErr) throw new Error(filesErr.message);
    if (!userFiles || userFiles.length < 2) {
      return NextResponse.json({ pairs: [], message: 'Need at least 2 files to compare.' });
    }

    const fileIds = userFiles.map(f => f.id);
    const fileMap = new Map(userFiles.map(f => [f.id, f]));

    // ── 2. Fetch first-chunk embeddings per file ──────────────────────────
    // We use chunk_index = 0 as the representative embedding for each file.
    // This is the opening content — generally the most identifying chunk.
    const { data: chunks, error: chunkErr } = await supabase
      .from('documents')
      .select('file_id, embedding')
      .in('file_id', fileIds)
      .eq('chunk_index', 0)
      .limit(200); // safety cap

    if (chunkErr) throw new Error(chunkErr.message);

    // Build file_id → embedding map
    // pgvector returns embeddings as number[] or stringified arrays
    const embMap = new Map<string, number[]>();
    for (const chunk of chunks ?? []) {
      if (!chunk.embedding) continue;
      const emb: number[] = Array.isArray(chunk.embedding)
        ? chunk.embedding
        : typeof chunk.embedding === 'string'
          ? JSON.parse(chunk.embedding)
          : [];
      if (emb.length > 0) embMap.set(chunk.file_id, emb);
    }

    console.log(`   Files: ${userFiles.length} | Embeddings loaded: ${embMap.size}`);

    // ── 3. Pairwise comparison ────────────────────────────────────────────
    const SEMANTIC_THRESHOLD = 0.82;
    const FILENAME_THRESHOLD = 3;    // Levenshtein distance

    const pairs: Array<{
      fileA:       { id: string; name: string; category: string; size: number; created_at: string };
      fileB:       { id: string; name: string; category: string; size: number; created_at: string };
      similarity:  number;
      reason:      'semantic' | 'filename' | 'both';
      label:       string;
    }> = [];

    const embEntries = [...embMap.entries()];
    const seen       = new Set<string>();

    for (let i = 0; i < embEntries.length; i++) {
      for (let j = i + 1; j < embEntries.length; j++) {
        const [idA, embA] = embEntries[i];
        const [idB, embB] = embEntries[j];

        const pairKey    = `${idA}:${idB}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        const fileA = fileMap.get(idA);
        const fileB = fileMap.get(idB);
        if (!fileA || !fileB) continue;

        const simScore   = cosine(embA, embB);
        const nameDistA  = baseName(fileA.name);
        const nameDistB  = baseName(fileB.name);
        const nameSim    = levenshtein(nameDistA, nameDistB) <= FILENAME_THRESHOLD && nameDistA.length > 3;

        const isSemanticDupe = simScore >= SEMANTIC_THRESHOLD;

        if (!isSemanticDupe && !nameSim) continue;

        const reason: 'semantic' | 'filename' | 'both' =
          isSemanticDupe && nameSim ? 'both'
          : isSemanticDupe ? 'semantic'
          : 'filename';

        const pct  = Math.round(simScore * 100);
        const label = reason === 'both'
          ? `${pct}% content match + similar filename`
          : reason === 'semantic'
            ? `${pct}% content similarity`
            : `Similar filenames (${Math.round((1 - levenshtein(nameDistA, nameDistB) / Math.max(nameDistA.length, nameDistB.length, 1)) * 100)}% name match)`;

        pairs.push({
          fileA: { id: idA, name: fileA.name, category: fileA.category, size: fileA.size, created_at: fileA.created_at },
          fileB: { id: idB, name: fileB.name, category: fileB.category, size: fileB.size, created_at: fileB.created_at },
          similarity: simScore,
          reason,
          label,
        });
      }
    }

    // Also check files without embeddings for filename similarity only
    for (let i = 0; i < userFiles.length; i++) {
      for (let j = i + 1; j < userFiles.length; j++) {
        const fA = userFiles[i];
        const fB = userFiles[j];
        const pairKey = `${fA.id}:${fB.id}`;
        if (seen.has(pairKey)) continue; // already covered above

        const nameA = baseName(fA.name);
        const nameB = baseName(fB.name);
        if (nameA.length < 4 || nameB.length < 4) continue;

        const dist = levenshtein(nameA, nameB);
        if (dist <= FILENAME_THRESHOLD) {
          seen.add(pairKey);
          const pct = Math.round((1 - dist / Math.max(nameA.length, nameB.length)) * 100);
          pairs.push({
            fileA: { id: fA.id, name: fA.name, category: fA.category, size: fA.size, created_at: fA.created_at },
            fileB: { id: fB.id, name: fB.name, category: fB.category, size: fB.size, created_at: fB.created_at },
            similarity: pct / 100,
            reason: 'filename',
            label: `Similar filenames (${pct}% name match)`,
          });
        }
      }
    }

    // Sort by similarity descending
    pairs.sort((a, b) => b.similarity - a.similarity);

    console.log(`   Found ${pairs.length} near-duplicate pair(s)`);

    return NextResponse.json({
      pairs,
      scanned: userFiles.length,
      message: pairs.length === 0
        ? `Scanned ${userFiles.length} files — no near-duplicates found.`
        : `Found ${pairs.length} near-duplicate pair${pairs.length > 1 ? 's' : ''} across ${userFiles.length} files.`,
    });

  } catch (err: any) {
    console.error('❌ Semantic dupe scan error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}


// PATH: app/api/files/preview/route.ts
// Returns a signed URL for INLINE rendering (no download disposition).
// Used by the preview panel iframe — browser renders PDF directly.
// The download route still exists separately for actual file downloads.
//
// KEY DIFFERENCE from download/route.ts:
//   download route → createSignedUrl(..., { download: fileName })
//     → Content-Disposition: attachment → browser downloads, refuses iframe
//   preview route  → createSignedUrl(...) with NO download flag
//     → Content-Disposition: inline → browser renders in iframe ✅

import { createClient }      from '@supabase/supabase-js';
import { getVerifiedUserId } from '@/lib/auth';
import { NextResponse }      from 'next/server';

export async function GET(req: Request) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  try {
    const { userId, error: authError } = await getVerifiedUserId(req);
    if (authError) return authError;

    const url    = new URL(req.url);
    const fileId = url.searchParams.get('fileId');
    if (!fileId)
      return NextResponse.json({ error: 'Missing fileId' }, { status: 400 });

    const { data: file, error: fetchErr } = await supabase
      .from('files')
      .select('id, name, user_id, storage_bucket_path, type')
      .eq('id', fileId)
      .maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!file)    return NextResponse.json({ error: 'File not found' }, { status: 404 });
    if (file.user_id !== userId)
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    if (!file.storage_bucket_path)
      return NextResponse.json({ error: 'Not available' }, { status: 404 });

    // ── NO download flag → Content-Disposition: inline ────────────────────
    // This is what makes the browser render the PDF in an iframe instead of
    // triggering a download.
    const { data: signed, error: signErr } = await supabase.storage
      .from('user-files')
      .createSignedUrl(file.storage_bucket_path, 3600);  // no download option

    if (signErr) throw new Error(signErr.message);

    return NextResponse.json({
      url:      signed.signedUrl,
      fileName: file.name,
      type:     file.type,
    });

  } catch (err: any) {
    console.error('Preview error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

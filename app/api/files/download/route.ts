// PATH: app/api/files/download/route.ts
// Generates a short-lived signed URL so the user can download the original file.
// Security: JWT verified + ownership checked before any URL is generated.

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
    if (!fileId) return NextResponse.json({ error: 'Missing fileId' }, { status: 400 });

    // Fetch file record and verify ownership
    const { data: file, error: fetchErr } = await supabase
      .from('files')
      .select('id, name, user_id, storage_bucket_path, type')
      .eq('id', fileId)
      .maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!file)    return NextResponse.json({ error: 'File not found' }, { status: 404 });
    if (file.user_id !== userId)
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // Graceful handling for files uploaded before storage was enabled
    if (!file.storage_bucket_path) {
      return NextResponse.json({
        error: 'Original file not available. This file was uploaded before storage was enabled. Re-upload to enable download.',
      }, { status: 404 });
    }

    // Generate signed URL — expires in 1 hour (3600 seconds)
    const { data: signed, error: signErr } = await supabase.storage
      .from('user-files')
      .createSignedUrl(file.storage_bucket_path, 3600, {
        download: file.name,  // browser downloads with original filename
      });

    if (signErr) throw new Error(signErr.message);

    return NextResponse.json({
      url:      signed.signedUrl,
      fileName: file.name,
      type:     file.type,
      expiresIn: 3600,
    });

  } catch (err: any) {
    console.error('Download error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

import { createClient }      from '@supabase/supabase-js';
import { getVerifiedUserId } from '@/lib/auth';
import { NextResponse } from 'next/server';

// ─────────────────────────────────────────────────────────────────────────────
// DELETE ROUTE — COMPLETE REWRITE
//
// THREE BUGS IN THE ORIGINAL:
//
// BUG 1 — Broken auth (same Next.js 15 cookie bug as upload/chat routes):
//   const cookieStore = cookies()  ← returns Promise, not actual cookies
//   Supabase got no session → deletes silently failed with auth errors.
//   Dashboard had no error feedback → button appeared to do nothing at all.
//
// BUG 2 — Document chunks not fully deleted:
//   .eq('file_id', fileId) only matches rows where the top-level file_id
//   column is populated. Pre-migration files stored file_id inside metadata{}
//   JSONB only → those chunks were never deleted, stayed in the DB forever.
//
// BUG 3 — No ownership check:
//   Any userId could delete any fileId — security hole.
//
// FIXES:
//   ① userId passed from browser session (same pattern as upload + chat)
//   ② Ownership verified before any delete operation
//   ③ Dual-path chunk deletion: by file_id column AND by metadata JSONB
//   ④ Errors returned to frontend so user sees a real message if it fails
// ─────────────────────────────────────────────────────────────────────────────

export async function DELETE(req: Request) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  try {
    const { fileId } = await req.json();
    if (!fileId) return NextResponse.json({ error: 'Missing fileId' }, { status: 400 });
    const { userId, error: authError } = await getVerifiedUserId(req);
    if (authError) return authError;

    console.log(`\n🗑️  ═══ DELETE ═══`);
    console.log(`   fileId : ${fileId}`);
    console.log(`   userId : ${userId}`);

    // ── 1. Fetch + verify ownership ───────────────────────────────────────────
    const { data: fileRecord, error: fetchError } = await supabase
      .from('files')
      .select('id, name, user_id, storage_bucket_path')
      .eq('id', fileId)
      .maybeSingle();

    if (fetchError) throw new Error(`Could not fetch file: ${fetchError.message}`);

    if (!fileRecord) {
      // Already deleted — treat as success so UI stays consistent
      return NextResponse.json({ success: true, message: 'File already deleted.' });
    }

    if (fileRecord.user_id !== userId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    console.log(`   Verified: "${fileRecord.name}" belongs to user ✓`);

    // ── 2. Delete document chunks — DUAL PATH ─────────────────────────────────
    //
    // Path A covers files uploaded AFTER the SQL migration
    //   (documents.file_id top-level column = fileId)
    //
    // Path B covers files uploaded BEFORE the SQL migration
    //   (file_id was only inside metadata JSONB, top-level column was NULL)
    //
    // Running both ensures ALL chunks are deleted regardless of when the
    // file was uploaded. Each path no-ops if it matches 0 rows.

    // Path A — top-level column
    const { error: errA } = await supabase
      .from('documents')
      .delete()
      .eq('file_id', fileId);

    if (errA) console.warn('   Path A warning (non-fatal):', errA.message);
    else      console.log('   Path A (file_id column) ✓');

    // Path B — JSONB metadata field
    const { error: errB } = await supabase
      .from('documents')
      .delete()
      .filter('metadata->>file_id', 'eq', fileId);

    if (errB) console.warn('   Path B warning (non-fatal):', errB.message);
    else      console.log('   Path B (metadata JSONB) ✓');

    // ── 3. Delete from Supabase Storage bucket ───────────────────────────────
    if (fileRecord.storage_bucket_path) {
      const { error: storageErr } = await supabase.storage
        .from('user-files')
        .remove([fileRecord.storage_bucket_path]);
      if (storageErr) console.warn('   Storage delete warning (non-fatal):', storageErr.message);
      else            console.log('   Storage bucket file deleted ✓');
    }

    // ── 4. Delete the file record itself ──────────────────────────────────────
    const { error: fileDelErr } = await supabase
      .from('files')
      .delete()
      .eq('id', fileId)
      .eq('user_id', userId);

    if (fileDelErr) throw new Error(`Failed to delete file: ${fileDelErr.message}`);

    console.log(`   File record deleted ✓`);
    console.log(`🗑️  ═══ DONE: "${fileRecord.name}" removed ═══\n`);

    return NextResponse.json({
      success: true,
      message: `"${fileRecord.name}" permanently deleted.`,
    });

  } catch (error: any) {
    console.error('❌ Delete Error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

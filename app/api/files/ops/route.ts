// PATH: app/api/files/ops/route.ts
//
// Executes confirmed file operations from the NL file management dialog.
// Called by the dashboard AFTER the user has confirmed the operation.
//
// Supported operations:
//   move     → update files.folder for given fileIds
//   archive  → set files.is_archived = true
//   restore  → set files.is_archived = false, reset folder to 'My Cloud'
//   delete   → hard delete files + their document chunks
//   rename   → update files.name (single file only)

import { createClient }      from '@supabase/supabase-js';
import { getVerifiedUserId } from '@/lib/auth';
import { NextResponse }      from 'next/server';

const VALID_FOLDERS = ['My Cloud', 'Finance', 'Health', 'Work', 'Personal', 'Archive'];

export async function POST(req: Request) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  try {
    const { userId, error: authError } = await getVerifiedUserId(req);
    if (authError) return authError;

    const body = await req.json();
    const { operation, fileIds, targetFolder, newName } = body as {
      operation:    'move' | 'archive' | 'restore' | 'delete' | 'rename';
      fileIds:      string[];
      targetFolder?: string;
      newName?:     string;
    };

    if (!operation || !fileIds?.length) {
      return NextResponse.json({ error: 'Missing operation or fileIds' }, { status: 400 });
    }

    // Verify all files belong to this user before touching anything
    const { data: ownedFiles, error: ownerErr } = await supabase
      .from('files')
      .select('id, name')
      .in('id', fileIds)
      .eq('user_id', userId);

    if (ownerErr) throw new Error(ownerErr.message);

    const ownedIds = (ownedFiles ?? []).map(f => f.id);
    const unauthorised = fileIds.filter(id => !ownedIds.includes(id));
    if (unauthorised.length > 0) {
      return NextResponse.json(
        { error: `Unauthorised access to ${unauthorised.length} file(s)` },
        { status: 403 },
      );
    }

    console.log(`\n📂 FILE OP: ${operation} on ${fileIds.length} file(s) [user: ${userId}]`);

    // ── Execute operation ────────────────────────────────────────────────────
    switch (operation) {

      case 'move': {
        const folder = targetFolder && VALID_FOLDERS.includes(targetFolder)
          ? targetFolder
          : 'My Cloud';
        const { error } = await supabase
          .from('files')
          .update({ folder, is_archived: false })
          .in('id', ownedIds)
          .eq('user_id', userId);
        if (error) throw new Error(error.message);
        console.log(`   ✅ Moved ${ownedIds.length} files → "${folder}"`);
        return NextResponse.json({
          success: true,
          affected: ownedIds.length,
          message: `Moved ${ownedIds.length} file${ownedIds.length > 1 ? 's' : ''} to "${folder}".`,
        });
      }

      case 'archive': {
        const { error } = await supabase
          .from('files')
          .update({ is_archived: true, folder: 'Archive' })
          .in('id', ownedIds)
          .eq('user_id', userId);
        if (error) throw new Error(error.message);
        console.log(`   ✅ Archived ${ownedIds.length} files`);
        return NextResponse.json({
          success: true,
          affected: ownedIds.length,
          message: `Archived ${ownedIds.length} file${ownedIds.length > 1 ? 's' : ''}.`,
        });
      }

      case 'restore': {
        const { error } = await supabase
          .from('files')
          .update({ is_archived: false, folder: 'My Cloud' })
          .in('id', ownedIds)
          .eq('user_id', userId);
        if (error) throw new Error(error.message);
        console.log(`   ✅ Restored ${ownedIds.length} files`);
        return NextResponse.json({
          success: true,
          affected: ownedIds.length,
          message: `Restored ${ownedIds.length} file${ownedIds.length > 1 ? 's' : ''} to My Cloud.`,
        });
      }

      case 'delete': {
        // Delete chunks first (two paths for pre/post migration files)
        for (const id of ownedIds) {
          await supabase.from('documents').delete().eq('file_id', id);
          await supabase.from('documents').delete().filter('metadata->>file_id', 'eq', id);
        }
        const { error } = await supabase
          .from('files')
          .delete()
          .in('id', ownedIds)
          .eq('user_id', userId);
        if (error) throw new Error(error.message);
        console.log(`   ✅ Deleted ${ownedIds.length} files`);
        return NextResponse.json({
          success: true,
          affected: ownedIds.length,
          message: `Permanently deleted ${ownedIds.length} file${ownedIds.length > 1 ? 's' : ''}.`,
        });
      }

      case 'rename': {
        if (ownedIds.length !== 1 || !newName?.trim()) {
          return NextResponse.json(
            { error: 'Rename requires exactly one fileId and a newName' },
            { status: 400 },
          );
        }
        const { error } = await supabase
          .from('files')
          .update({ name: newName.trim() })
          .eq('id', ownedIds[0])
          .eq('user_id', userId);
        if (error) throw new Error(error.message);
        console.log(`   ✅ Renamed to "${newName.trim()}"`);
        return NextResponse.json({
          success: true,
          affected: 1,
          message: `Renamed to "${newName.trim()}".`,
        });
      }

      default:
        return NextResponse.json({ error: `Unknown operation: ${operation}` }, { status: 400 });
    }

  } catch (err: any) {
    console.error('❌ File ops error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

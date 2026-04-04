export const dynamic = 'force-dynamic'
// PATH: app/api/files/reclassify/route.ts
// Allows the user to correct a wrong AI classification.
// Updates: files.category, documents.category, inserts correction into classification_log.
// This closes the feedback loop — every correction improves the system's trackable accuracy.

import { createClient }      from '@supabase/supabase-js';
import { getVerifiedUserId } from '@/lib/auth';
import { NextResponse }      from 'next/server';

const KNOWN_CATEGORIES = [
  'Government ID','Certificate','Research Paper','University Report',
  'Resume & CV','Salary & Pay Slip','Bank Statement','Tax Document',
  'Receipt & Invoice','Medical Record','Legal Document','Business Report',
  'Handwritten Note','Technical Diagram','Code & Tech','Travel Ticket',
  'QR Code & Barcode','Chat & Conversation','Social Media','Map & Navigation',
  'Study Notes','Data & Dashboard','Portrait & Selfie','Group & Family',
  'Personal Event','Professional Event','Architecture & Building',
  'Nature & Landscape','Urban & Transit','Vehicle','Electronics & Gadget',
  'Animals & Wildlife','Food & Beverage','Apparel & Fashion','General',
];

export async function PATCH(req: Request) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  try {
    const { userId, error: authError } = await getVerifiedUserId(req);
    if (authError) return authError;

    const { fileId, newCategory } = await req.json();

    if (!fileId || !newCategory)
      return NextResponse.json({ error: 'Missing fileId or newCategory' }, { status: 400 });

    if (!KNOWN_CATEGORIES.includes(newCategory))
      return NextResponse.json({ error: `Unknown category: "${newCategory}"` }, { status: 400 });

    // Verify ownership + get current category
    const { data: file, error: fetchErr } = await supabase
      .from('files')
      .select('id, name, user_id, category')
      .eq('id', fileId)
      .maybeSingle();

    if (fetchErr)     throw new Error(fetchErr.message);
    if (!file)        return NextResponse.json({ error: 'File not found' }, { status: 404 });
    if (file.user_id !== userId)
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const originalCategory = file.category;
    if (originalCategory === newCategory)
      return NextResponse.json({ success: true, message: 'Category unchanged.' });

    // 1. Update files table
    const { error: updateErr } = await supabase
      .from('files')
      .update({ category: newCategory })
      .eq('id', fileId)
      .eq('user_id', userId);
    if (updateErr) throw new Error(updateErr.message);

    // 2. Update all document chunks for this file
    await supabase
      .from('documents')
      .update({ category: newCategory })
      .eq('file_id', fileId);
    // Also update inside metadata JSONB (non-fatal — RPC may not exist yet)
    try {
      await supabase.rpc('update_document_metadata_category', {
        p_file_id:  fileId,
        p_category: newCategory,
      });
    } catch { /* RPC not created yet — skip silently */ }

    // 3. Log the correction — try UPDATE first, INSERT if no row exists
    const { data: existingLog } = await supabase
      .from('classification_log')
      .select('id')
      .eq('file_id', fileId)
      .maybeSingle();

    if (existingLog) {
      // Row exists from upload — UPDATE it with the correction
      await supabase
        .from('classification_log')
        .update({
          corrected_category: newCategory,
          corrected_by:       'user',
          corrected_at:       new Date().toISOString(),
        })
        .eq('file_id', fileId);
    } else {
      // No row yet — INSERT a fresh correction record
      await supabase
        .from('classification_log')
        .insert({
          file_id:            fileId,
          user_id:            userId,
          ai_category:        originalCategory,
          corrected_category: newCategory,
          corrected_by:       'user',
          corrected_at:       new Date().toISOString(),
        });
    }

    console.log(`✏️  Reclassified "${file.name}": "${originalCategory}" → "${newCategory}"`);

    return NextResponse.json({
      success:           true,
      fileName:          file.name,
      originalCategory,
      newCategory,
      message:           `Reclassified from "${originalCategory}" to "${newCategory}".`,
    });

  } catch (err: any) {
    console.error('Reclassify error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}


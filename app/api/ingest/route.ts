import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { VoyageAIClient } from "voyageai";

// 1. Initialize Voyage Client with a Type Guard
const voyage = new VoyageAIClient({ 
  apiKey: process.env.VOYAGE_API_KEY as string 
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { file_id, storage_path } = body;

    // 2. Setup Supabase Client
    const cookieStore = cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) {
            return cookieStore.get(name)?.value;
          },
        },
      }
    );

    // 3. Security Check
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 4. Download File from Supabase Storage
    console.log(`📂 Downloading: ${storage_path}`);
    const { data: blob, error: downloadError } = await supabase.storage
      .from('user-files')
      .download(storage_path);

    if (downloadError) throw downloadError;
    const buffer = Buffer.from(await blob.arrayBuffer());

    // 5. Universal Text Extraction
    let rawText = "";
    if (storage_path.toLowerCase().endsWith('.pdf')) {
      const pdfData = await pdf(buffer);
      rawText = pdfData.text;
    } else if (storage_path.toLowerCase().endsWith('.docx')) {
      const result = await mammoth.extractRawText({ buffer });
      rawText = result.value;
    } else {
      rawText = buffer.toString('utf-8');
    }

    // 6. Intelligent Chunking
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });
    const output = await splitter.createDocuments([rawText]);
    const textChunks = output.map(d => d.pageContent);

    console.log(`✂️ Created ${textChunks.length} chunks. Starting Rate-Limit Proof Embedding...`);

    const allEmbeddings: number[][] = [];
    
    // 7. THE BATCHING ENGINE (Optimized for 3 RPM Limit)
    // Voyage allows 128 chunks per request. We use this to minimize the number of requests.
    const batchSize = 128; 

    for (let i = 0; i < textChunks.length; i += batchSize) {
      const batch = textChunks.slice(i, i + batchSize);
      const currentBatchNumber = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(textChunks.length / batchSize);

      console.log(`📡 Sending Batch ${currentBatchNumber}/${totalBatches} to Voyage AI...`);
      
      const response = await voyage.embed({
        input: batch,
        model: "voyage-3",
        inputType: "document" // Corrected property name (inputType)
      });

      if (response.data) {
        allEmbeddings.push(...response.data.map(item => item.embedding as number[]));
      }

      // 8. THE THROTTLER (Wait 25s if more batches remain)
      // This ensures we stay well under the 3 Requests Per Minute (RPM) limit.
      if (i + batchSize < textChunks.length) {
        console.log("⏳ Rate limit safety: Sleeping for 25 seconds before next batch...");
        await new Promise(resolve => setTimeout(resolve, 25000));
      }
    }

    // 9. Prepare Records for Supabase
    const records = allEmbeddings.map((embedding, index) => ({
      content: textChunks[index],
      embedding: embedding,
      metadata: { 
        file_id, 
        filename: storage_path 
      },
    }));

    // 10. Final Database Insert
    if (records.length > 0) {
      console.log(`💾 Saving ${records.length} vectors to Supabase...`);
      const { error: insertError } = await supabase.from('documents').insert(records);
      if (insertError) throw insertError;
    }

    console.log("✅ Indexing Complete!");
    return NextResponse.json({ 
      success: true, 
      message: `Successfully indexed ${records.length} chunks.` 
    });

  } catch (e: any) {
    console.error('❌ Ingest Error:', e);
    return NextResponse.json(
      { error: e.message || 'Internal Server Error' }, 
      { status: 500 }
    );
  }
}
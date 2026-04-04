// PATH: app/api/chat/route.ts
import { createClient }      from '@supabase/supabase-js';
import { getVerifiedUserId } from '@/lib/auth';
import { NextResponse }  from 'next/server';
import { VoyageAIClient } from 'voyageai';
import { Groq }           from 'groq-sdk';

const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY! });
const groq   = new Groq({ apiKey: process.env.GROQ_API_KEY! });

const FAST_MODEL      = 'meta-llama/llama-4-scout-17b-16e-instruct';
const SYNTHESIS_MODEL = 'llama-3.3-70b-versatile';

interface NormalizedChunk {
  content: string; file_name: string; file_id: string;
  file_type: string; page_number: number | null;
  chunk_index: number; total_pages: number | null; category: string;
}

function normalizeChunk(raw: any): NormalizedChunk {
  const m = raw.metadata || {};
  return {
    content:     raw.content     ?? '',
    file_name:   raw.file_name   ?? m.file_name   ?? 'Unknown File',
    file_id:     raw.file_id     ?? m.file_id      ?? '',
    file_type:   raw.file_type   ?? m.file_type    ?? 'unknown',
    page_number: (raw.page_number !== undefined ? raw.page_number : m.page_number) ?? null,
    chunk_index: (raw.chunk_index !== undefined ? raw.chunk_index : m.chunk_index) ?? 0,
    total_pages: (raw.total_pages !== undefined ? raw.total_pages : m.total_pages) ?? null,
    category:    raw.category    ?? m.category     ?? 'General',
  };
}

interface QueryIntent {
  type: 'PAGE_SPECIFIC' | 'IMAGE_QUERY' | 'SUMMARY' | 'COMPARISON' | 'KEYWORD_SEARCH' | 'GENERAL';
  pageNumber: number | null; keywords: string[]; isSynthesis: boolean;
}

function detectIntent(message: string, fileCount: number): QueryIntent {
  const lower = message.toLowerCase();

  // ── COMPARISON detection (separate from synthesis) ──────────────────────
  // "compare", "comparison", "difference between", "vs" when files are selected
  // These should use the SELECTED files only — never trigger full synthesis mode
  const isComparison = fileCount >= 2 && [
    'compare', 'comparison between', 'difference between', 'contrast',
    'similarities', 'how are these different', 'how do these differ',
  ].some(s => lower.includes(s));

  // ── SYNTHESIS: write/create/generate a NEW document ─────────────────────
  // "write me a comparison" is ambiguous — user means COMPARE, not CREATE.
  // So "write me a" only triggers synthesis when combined with document words.
  const isSynthesis = !isComparison && [
    'write a report', 'write a summary', 'write a document', 'write an essay',
    'create a document', 'create a report', 'generate a document', 'generate a report',
    'draft a', 'draft an', 'compose a', 'produce a report',
    'combine these into', 'synthesize these', 'merge these',
  ].some(s => lower.includes(s));

  const pageMatch = lower.match(/page\s+(\d+)|(\d+)(?:st|nd|rd|th)?\s+page/);
  if (pageMatch) return { type: 'PAGE_SPECIFIC', pageNumber: parseInt(pageMatch[1] || pageMatch[2]), keywords: [], isSynthesis };

  if (isComparison) return { type: 'COMPARISON', pageNumber: null, keywords: [], isSynthesis: false };

  if (['image','photo','picture','screenshot','describe this','see in','look like'].some(w => lower.includes(w)))
    return { type: 'IMAGE_QUERY', pageNumber: null, keywords: [], isSynthesis };

  if (['summarize','summary','overview','key points','main points','brief'].some(w => lower.includes(w)))
    return { type: 'SUMMARY', pageNumber: null, keywords: [], isSynthesis };

  const stopWords = new Set(['what','where','when','how','why','who','is','are','was','were','the','a','an',
    'this','that','file','document','about','tell','me','find','get','show','can','you','please',
    'in','of','for','and','or','my','i','it','from','with','on','do']);
  const keywords = lower.split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, '')).filter(w => w.length > 2 && !stopWords.has(w));

  if (keywords.length > 0) return { type: 'KEYWORD_SEARCH', pageNumber: null, keywords, isSynthesis };
  return { type: 'GENERAL', pageNumber: null, keywords: [], isSynthesis };
}

function selectChunks(chunks: NormalizedChunk[], intent: QueryIntent, max = 45): NormalizedChunk[] {
  const sorted = [...chunks].sort((a, b) => a.chunk_index - b.chunk_index);
  if (intent.isSynthesis || intent.type === 'COMPARISON') return sorted.slice(0, Math.min(max, sorted.length));

  switch (intent.type) {
    case 'PAGE_SPECIFIC': {
      const pg = intent.pageNumber!;
      // PAGE_SPECIFIC caps at 4 chunks max — more than that and the model
      // summarises everything rather than citing the specific page content
      const PAGE_MAX = 4;
      const exact = sorted.filter(c => c.page_number === pg);
      if (exact.length > 0) return exact.slice(0, PAGE_MAX);
      const near = sorted.filter(c => c.page_number !== null && Math.abs((c.page_number ?? 0) - pg) <= 1);
      if (near.length > 0) return near.slice(0, PAGE_MAX);
      // page_number NULL (older uploads) — estimate by chunk_index (~2 chunks/page)
      const estStart = Math.max(0, (pg - 1) * 2);
      return sorted.slice(estStart, estStart + PAGE_MAX);
    }
    case 'IMAGE_QUERY': {
      const img = sorted.filter(c => c.file_type === 'image' || c.content.includes('[IMAGE ANALYSIS'));
      return img.length > 0 ? img.slice(0, max) : sorted.slice(0, max);
    }
    case 'SUMMARY': {
      const total = sorted.length;
      const first = sorted.filter(c => (c.page_number ?? 1) <= 3 || c.chunk_index < 6);
      const mid   = sorted.slice(Math.floor(total * 0.35), Math.floor(total * 0.65)).slice(0, 10);
      const last  = sorted.filter(c => c.chunk_index >= total - 3).slice(0, 5);
      const seen  = new Set<number>();
      return [...first, ...mid, ...last].filter(c => { if (seen.has(c.chunk_index)) return false; seen.add(c.chunk_index); return true; }).slice(0, max);
    }
    case 'KEYWORD_SEARCH': {
      const scored = sorted.map(c => {
        const text  = c.content.toLowerCase();
        const score = intent.keywords.reduce((s, kw) => s + (text.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 0);
        return { c, score };
      }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).map(x => x.c);
      return scored.length > 0 ? scored.slice(0, max) : sorted.slice(0, max);
    }
    default: return sorted.slice(0, max);
  }
}

function buildSystemPrompt(
  now: Date,
  userMemory: string,
  wantsSource: boolean,
  isSynthesis: boolean,
  isComparison: boolean,
  selectedFileNames: string[],
  allFiles: any[],
  userEmail: string,
): string {
  const dateStr = now.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Kolkata' });
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata', hour12: true });

  const memoryBlock = userMemory ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LONG-TERM MEMORY (from past conversations)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Use naturally. Never say "I remember" or "my memory shows". Just use it.
${userMemory}` : '';

  const sourceBlock = wantsSource ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SOURCE TRANSPARENCY (user asked why/how you know)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 SOURCE: [Exact filename + page number, OR "General world knowledge"]
🧠 REASONING: [1-2 sentences: how you reached this answer]
✅ ANSWER: [The actual answer]` : '';

  const synthesisBlock = isSynthesis ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SYNTHESIS MODE — CREATE A DOCUMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Produce a complete, well-structured Markdown document using ONLY the FILE CONTENT below.
- Start with ## [Title]
- Use ONLY real facts from the files listed in SELECTED FILES — no fabrication
- End with: ---\n*Synthesised from: [list ONLY the filenames that had content in FILE CONTENT]*
- Be professional and thorough
- NEVER mention or reference files that are NOT in the FILE CONTENT section below` : '';

  // ── COMPARISON mode prompt ───────────────────────────────────────────────
  // Critical: tell the model to ONLY compare the selected files,
  // and to IGNORE any other files it sees in "YOUR CLOUD" section.
  const comparisonBlock = isComparison ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMPARISON MODE — STRICT FILE SCOPE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The user has selected EXACTLY these files to compare:
${selectedFileNames.map(n => `  • "${n}"`).join('\n')}

STRICT RULES FOR COMPARISON:
1. ONLY compare the files listed above — nothing else
2. Do NOT mention, include, or reference any other file from "YOUR CLOUD"
3. Base your comparison ONLY on the content in FILE CONTENT below
4. Structure: use a markdown table or clear side-by-side sections
5. If one of the selected files has no extractable text (e.g. image-only), say so explicitly for that file
6. End with: *Comparison based on: ${selectedFileNames.map(n => `"${n}"`).join(', ')}*` : '';

  // ── SELECTED FILES block (shown to model whenever files are selected) ────
  // Even outside comparison/synthesis, the model needs to know which files
  // the user is asking about so it doesn't bleed into unselected files.
  const selectedBlock = selectedFileNames.length > 0 ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SELECTED FILES (user's active scope — answer ONLY from these)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${selectedFileNames.map(n => `  ✅ "${n}"`).join('\n')}

⛔ Do NOT discuss or reference files that are NOT in this list, even if they appear in YOUR CLOUD below.
⛔ Your answer must be based entirely on the content of the SELECTED FILES above.
⛔ If the user asks about something not found in these files, say so — don't pull from other files.` : '';

  const pageSpecificBlock = (isSynthesis === false && isComparison === false) ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PAGE-SPECIFIC QUERY RULES (apply ONLY when asked about a specific page)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
If the user asks "what is on page N?" or "what does page N say?":
▸ Answer ONLY using content marked [Page N] in the FILE CONTENT below
▸ Begin your answer with: "Page [N] of [filename] contains:"
▸ Quote the actual text from that page — do not paraphrase the whole document
▸ If the page content is short, quote it exactly
▸ Do NOT include content from any other page
▸ Do NOT write a document summary when asked about a specific page` : '';

  // ── Self-awareness block: AI knows its own environment ──────────────────
  // This is what makes it feel like Claude/ChatGPT — the AI understands
  // its own context: who the user is, what files they have, what system it's on.
  const categoryBreakdown = Object.entries(
    (allFiles || []).reduce<Record<string,number>>((acc, f: any) => {
      const c = f.category || 'General';
      acc[c] = (acc[c] || 0) + 1;
      return acc;
    }, {})
  ).sort((a, b) => b[1] - a[1]).slice(0, 5)
   .map(([c, n]) => `${c} (${n})`).join(', ');

  const selfAwarenessBlock = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SELF-AWARENESS — YOUR ENVIRONMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You are Superior Cloud Intelligence — a next-generation personal AI cloud.
▸ Platform    : Superior Cloud Intelligence v1.0
▸ AI Engine   : Llama 4 Scout (chat) · Llama 3.3 70B (synthesis) · Llama 3.1 8B (memory)
▸ Embeddings  : Voyage-3 (1024-dim semantic vectors, pgvector)
▸ User        : ${userEmail || 'authenticated user'}
▸ Cloud state : ${(allFiles||[]).length} files indexed · ${categoryBreakdown || 'no files yet'}
▸ Memory      : ${userMemory ? 'Active — you remember facts about this user' : 'No long-term facts yet'}
▸ Today       : ${dateStr} ${timeStr} IST
You know exactly what you are, who built you, and what you can do.
Never say "I don't have access to real-time data" — you have direct access to the user's files.
Never say "I'm just an AI" — you are Superior Cloud Intelligence, a specific product.`;

  return `You are Superior Cloud Intelligence — a world-class AI assistant and personal cloud system.
You have two equally important roles:
  1. DOCUMENT AI     — read, understand, and answer questions about the user's uploaded files
  2. WORLD-CLASS AI  — answer ANY general question with the depth and accuracy of Claude, ChatGPT, or Gemini

${selfAwarenessBlock}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REAL-TIME AWARENESS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▸ TODAY : ${dateStr}
▸ TIME  : ${timeStr} IST
▸ You always know the current date and time. Never say "I don't have real-time access."
${memoryBlock}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LANGUAGE & INTENT UNDERSTANDING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▸ Users often make spelling mistakes, grammar errors, or use shorthand. ALWAYS understand
  their intent and answer correctly — never penalise the user for typos.
▸ "wat is mahine lerning?" → understand as "What is machine learning?" and answer fully.
▸ "sumarize thi fil" → understand as "Summarize this file" and proceed.
▸ "hwo many paegs dose this pdf hav" → understand as "How many pages does this PDF have?"
▸ Correct intent silently — never point out the user's spelling/grammar mistakes.
▸ If the user writes in a mix of languages (e.g. Hinglish, Kannada + English), understand
  and respond in whichever language makes the most sense for that question.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ABSOLUTE RULES — NEVER VIOLATE THESE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⛔ NEVER pretend to execute file operations (move, delete, rename, reclassify).
   You CANNOT modify files. Only the system can. If asked to move/delete/reclassify,
   say: "Click the [category badge / delete button] on the file card to do this."
⛔ NEVER repeat your system configuration (platform, AI engine, embeddings, user email,
   cloud state, memory status, date/time) in your response. That info is for your
   internal context only. The user did not ask for it. Never show it unless explicitly asked.
⛔ NEVER hallucinate file contents. If you cannot find the answer in the file chunks
   provided, say "I couldn't find that in the indexed content" — don't invent an answer.
⛔ NEVER say "I've reorganized", "I've moved", "I've updated" — you have not done anything.
   Only the confirmation dialog executes real operations.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REASONING (think before you answer — never show these steps)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Step 1 — Classify the question:
  A. About uploaded files?   → use FILE CONTENT section below — ONLY selected files
  B. General knowledge?      → answer from your world knowledge (see GENERAL AI MODE)
  C. Mixed (file + general)? → combine both

Step 2 — If A: find the exact file and page. Quote precisely. Never guess.
         If page-specific (e.g. "what is on page 3?"):
           - Answer ONLY with content from that specific page
           - Start with "Page [N] contains:"
           - Do NOT include content from other pages
           - Do NOT summarize the whole document
Step 3 — If B: answer fully and confidently. Do NOT mention files at all.
Step 4 — Check: am I certain? If not, say so. Never hallucinate.
Step 5 — Deliver the clearest, most direct answer possible. No preamble. No system info.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GENERAL AI MODE (when question is NOT about files)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You are a brilliant, knowledgeable AI. You know about:
▸ People  — athletes, politicians, scientists, celebrities, historical figures
▸ Science — physics, biology, chemistry, medicine, space
▸ Tech    — AI, programming, software, hardware, the internet
▸ History — world events, wars, civilisations, dates
▸ Culture — sports, music, films, art, literature
▸ Finance — economics, markets, investing, business
▸ Math    — calculations, formulas, proofs
▸ And everything else a world-class AI would know

CRITICAL RULE FOR GENERAL QUESTIONS:
▸ If the FILE CONTENT section says "NO FILE CONTEXT" — this is a general question
▸ Answer it fully from your training knowledge — same quality as Claude or ChatGPT
▸ NEVER say "I don't have that in my files" or "that information isn't in your documents"
▸ NEVER refuse to answer a general knowledge question
▸ A question like "who is Virat Kohli?" → answer it like Wikipedia + expert commentary
${sourceBlock}${synthesisBlock}${comparisonBlock}${pageSpecificBlock}
{web_search_block}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR CLOUD (all files in this user's account — for context only)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{system_state}
${selectedBlock}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FILE CONTENT (extracted text from selected files only)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{retrieved_context}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

interface ChatBody { message: string; fileFilter: string[]; history: { role: 'user' | 'assistant'; content: string }[]; }

// ─────────────────────────────────────────────────────────────────────────────
//  FILE OPERATION KEYWORDS
//  If a user message matches these, we skip the normal chat flow entirely and
//  return a structured JSON preview for the confirmation dialog.
// ─────────────────────────────────────────────────────────────────────────────
const FILE_OP_VERBS = [
  'move', 'put', 'place', 'shift', 'transfer', 'send',
  'organize', 'sort', 'group', 'arrange',
  'archive', 'store away', 'hide',
  'delete', 'remove', 'clean up', 'get rid of',
  'restore', 'unarchive', 'bring back',
  'rename', 'change the name',
  'reclassify', 'change category', 'change the category',
  'label', 'label as', 'categorize', 'categorise',
  'tag as', 'mark as',
];
const FILE_OP_OBJECTS = [
  'files', 'documents', 'invoices', 'receipts', 'records',
  'reports', 'images', 'photos', 'slips', 'statements',
  'pdf', 'png', 'jpg', 'docx',
];
const FILE_OP_FOLDERS  = ['finance','health','work','personal','archive','my cloud','general','folder'];
const FILE_OP_CATEGORIES = [
  'government id','certificate','resume','salary','bank statement','tax',
  'receipt','medical','legal','business report','research paper',
  'university report','handwritten','technical diagram','code','travel ticket',
  'qr code','chat','social media','map','study notes','data','portrait',
  'group','personal event','professional event','architecture','nature',
  'urban','vehicle','electronics','animals','food','apparel','general',
];

function isFileOpMessage(msg: string, fileNames: string[] = []): boolean {
  const lower = msg.toLowerCase();

  const hasVerb     = FILE_OP_VERBS.some(v => lower.includes(v));
  const hasObject   = FILE_OP_OBJECTS.some(o => lower.includes(o));
  const hasFolder   = FILE_OP_FOLDERS.some(f => lower.includes(f));
  const hasCategory = FILE_OP_CATEGORIES.some(c => lower.includes(c));
  // Check if message mentions an actual filename (fuzzy — strip extension and check)
  const hasFileName = fileNames.some(name => {
    const base = name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
    const words = base.split(' ').filter(w => w.length > 3);
    return words.some(w => lower.includes(w));
  });

  // Broad target pattern: "to/into/in/under/as" + folder/category
  const hasTarget = /\b(to|into|in|under|as|the)\s+(finance|health|work|personal|archive|my cloud|general|\w+\s+folder|\w+\s+category)\b/i.test(msg);

  return hasVerb && (hasObject || hasFolder || hasCategory || hasFileName || hasTarget);
}

// ─────────────────────────────────────────────────────────────────────────────
//  FILE OP PARSER — 70B model identifies which files to act on
// ─────────────────────────────────────────────────────────────────────────────
async function parseFileOperation(
  message:  string,
  allFiles: { id: string; name: string; category: string; created_at: string; folder?: string }[],
): Promise<{
  operation:     'move' | 'archive' | 'delete' | 'restore' | 'rename' | 'reclassify';
  fileIds:       string[];
  targetFolder?: string;
  targetCategory?: string;
  summary:       string;
  explanation:   string;
} | null> {
  try {
    const fileList = allFiles
      .slice(0, 80) // safety cap
      .map((f, i) => `${i + 1}. ID:${f.id} | "${f.name}" | Category:${f.category} | Date:${f.created_at.slice(0,10)} | Folder:${f.folder ?? 'My Cloud'}`)
      .join('\n');

    const resp = await groq.chat.completions.create({
      model: SYNTHESIS_MODEL, // 70B for reliable JSON
      messages: [
        {
          role: 'system',
          content: `You parse natural language file management commands into structured JSON.
Available operations:
  "move"        — change which folder a file is in
  "archive"     — hide file in archive
  "delete"      — permanently remove file
  "restore"     — unarchive a file
  "rename"      — change file name (single file only)
  "reclassify"  — change the AI category/label of a file

Available folders: "My Cloud", "Finance", "Health", "Work", "Personal", "Archive".
Available categories: "Government ID", "Certificate", "Resume & CV", "Salary & Pay Slip",
  "Bank Statement", "Tax Document", "Receipt & Invoice", "Medical Record", "Legal Document",
  "Business Report", "Research Paper", "University Report", "Handwritten Note",
  "Technical Diagram", "Code & Tech", "Travel Ticket", "QR Code & Barcode",
  "Chat & Conversation", "Social Media", "Map & Navigation", "Study Notes",
  "Data & Dashboard", "Portrait & Selfie", "Group & Family", "Personal Event",
  "Professional Event", "Architecture & Building", "Nature & Landscape",
  "Urban & Transit", "Vehicle", "Electronics & Gadget", "Animals & Wildlife",
  "Food & Beverage", "Apparel & Fashion", "General".

CRITICAL RULES:
- When command uses "all", "every", or file type ("all PDFs", "all images", "my documents") -> include ALL matching fileIds in the array, not just one.
- Match file types: "PDFs" matches type containing "pdf"; "images"/"photos" matches type containing "image"; "docs"/"word files" matches type containing "word"
- "move X to General/Finance/Work etc" where target is a CATEGORY → use "reclassify"
- "move X to Finance/Work/Health folder" where target is a FOLDER → use "move"
- Match file names fuzzily — "linkedin Banner" matches "LinkedIn Banner.png"
Return ONLY valid JSON. No explanation. No markdown.
Format: {"operation":"move"|"archive"|"delete"|"restore"|"rename"|"reclassify","fileIds":["id1","id2"],"targetFolder":"folder or null","targetCategory":"category or null","summary":"1-sentence human summary","explanation":"why these files match the command"}`,
        },
        {
          role: 'user',
          content: `Files:\n${fileList}\n\nCommand: "${message}"\n\nReturn JSON:`,
        },
      ],
      temperature:     0.0,
      max_tokens:      800,
      response_format: { type: 'json_object' },
    });

    const raw    = resp.choices[0].message.content ?? '';
    const parsed = JSON.parse(raw);

    if (!parsed.operation || !Array.isArray(parsed.fileIds) || parsed.fileIds.length === 0) {
      return null;
    }

    // Validate that returned IDs actually belong to this user's file list
    const validIds = new Set(allFiles.map(f => f.id));
    const safeIds  = (parsed.fileIds as string[]).filter(id => validIds.has(id));
    if (safeIds.length === 0) return null;

    return {
      operation:      parsed.operation,
      fileIds:        safeIds,
      targetFolder:   parsed.targetFolder   ?? undefined,
      targetCategory: parsed.targetCategory ?? undefined,
      summary:        parsed.summary        ?? `${parsed.operation} ${safeIds.length} file(s)`,
      explanation:    parsed.explanation    ?? '',
    };
  } catch (e: any) {
    console.warn('   File op parse failed:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  WEB SEARCH — Tavily AI (free tier: 1000 searches/month, no credit card)
//  Sign up: https://app.tavily.com → get your API key → add to .env.local:
//    TAVILY_API_KEY=tvly-xxxxxxxxxxxx
//
//  How it works:
//    1. detectsWebSearchNeeded() checks if the query is about current events
//    2. If yes → call Tavily → get 5 fresh results with URLs + snippets
//    3. Inject results as WEB SEARCH RESULTS block in the system prompt
//    4. Model uses those results to answer with real-time accuracy
// ─────────────────────────────────────────────────────────────────────────────

const WEB_SEARCH_TRIGGERS = [
  // Time-sensitive queries
  'latest', 'recent', 'current', 'today', 'right now', 'just now',
  'this week', 'this month', 'this year', '2024', '2025', '2026',
  'yesterday', 'last week', 'last month', 'breaking',
  // Sports
  'score', 'match', 'game', 'winner', 'champion', 'ipl', 'fifa',
  'cricket', 'football', 'tennis', 'olympics', 'tournament', 'final',
  'vs', 'versus', 'result', 'standings', 'ranking',
  // News & Current events
  'news', 'update', 'announce', 'release', 'launch', 'new model',
  'who won', 'who is the', 'what happened', 'election', 'president',
  'prime minister', 'ceo', 'stock price', 'market', 'weather',
  // Tech & AI
  'gpt-5', 'gemini', 'claude', 'llama', 'openai', 'google', 'apple',
  'iphone', 'latest version', 'new feature', 'just released',
];

function needsWebSearch(message: string): boolean {
  const lower = message.toLowerCase();
  // Don't search for file-specific questions
  if (lower.includes('my file') || lower.includes('this pdf') ||
      lower.includes('this document') || lower.includes('page ')) return false;
  return WEB_SEARCH_TRIGGERS.some(t => lower.includes(t));
}

async function searchWeb(query: string): Promise<string> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    // Graceful fallback — feature disabled if no key
    return '';
  }
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key:      apiKey,
        query,
        search_depth: 'basic',
        max_results:  5,
        include_answer: true,
      }),
      signal: AbortSignal.timeout(8000), // 8s timeout — never block chat
    });
    if (!res.ok) return '';
    const data = await res.json();

    // Format results for injection into system prompt
    const lines: string[] = [];
    if (data.answer) lines.push(`QUICK ANSWER: ${data.answer}`);
    (data.results || []).slice(0, 5).forEach((r: any, i: number) => {
      lines.push(`[${i+1}] ${r.title}`);
      lines.push(`    ${r.content?.slice(0, 300) || ''}...`);
      lines.push(`    Source: ${r.url}`);
    });
    return lines.join('\n');
  } catch {
    return ''; // Never crash the chat for a failed search
  }
}

export async function POST(req: Request) {
  // PATH: app/api/chat/route.ts
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  try {
    const { message, fileFilter = [], history = [] } = await req.json() as ChatBody;
    const { userId, error: authError } = await getVerifiedUserId(req);
    // Extract userEmail from JWT for self-awareness context
    let userEmail = '';
    try {
      const supabaseTemp = require('@supabase/supabase-js').createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!
      );
      const token = req.headers.get('Authorization')?.slice(7) || '';
      const { data: { user } } = await supabaseTemp.auth.getUser(token);
      userEmail = user?.email || '';
    } catch {}
    if (authError) return authError;

    const noFiles    = fileFilter.length === 0;
    const lowerMsg   = message.toLowerCase();

    // ── FILE OPERATION PRE-CHECK ─────────────────────────────────────────────
    // Pre-fetch file list so isFileOpMessage can match against real filenames.
    // Lazy-loaded here only when we haven't done the full fetch yet.
    const { data: quickFiles } = await supabase
      .from('files')
      .select('id, name, category, created_at, folder, is_archived')
      .eq('user_id', userId);
    const quickFileNames = (quickFiles || []).map((f: any) => f.name);

    if (isFileOpMessage(message, quickFileNames)) {
      console.log(`\n📂 FILE OP detected: "${message.slice(0, 80)}"`);

      const allFilesForOp = quickFiles; // already fetched above

      const parsedOp = await parseFileOperation(message, allFilesForOp ?? []);

      if (parsedOp) {
        const affectedFiles = (allFilesForOp ?? [])
          .filter(f => parsedOp.fileIds.includes(f.id))
          .map(f => ({ id: f.id, name: f.name, category: f.category }));

        console.log(`   ✅ Parsed op: ${parsedOp.operation} on ${affectedFiles.length} file(s)`);

        return NextResponse.json({
          type:           'file_op_preview',
          operation:      parsedOp.operation,
          fileIds:        parsedOp.fileIds,
          files:          affectedFiles,
          targetFolder:   parsedOp.targetFolder,
          targetCategory: (parsedOp as any).targetCategory,
          summary:        parsedOp.summary,
          explanation:    parsedOp.explanation,
        });
      }
      // If parsing failed, fall through to normal chat (AI will explain it can't do it)
      console.log(`   ⚠️  File op parse returned null — falling through to normal chat`);
    }

    // Load files list first — needed for intent detection (fileCount) and selected names
    const [filesResult, memResult] = await Promise.all([
      supabase.from('files').select('id, name, category, size, type, tags').eq('user_id', userId),
      supabase.from('user_memory').select('memory_text').eq('user_id', userId).maybeSingle(),
    ]);

    const allFiles   = filesResult.data ?? [];
    const userMemory = memResult.data?.memory_text ?? '';

    // ── FIX: Resolve exactly which files the user selected ─────────────────
    // selectedFileNames is passed directly into the prompt so the model
    // cannot confuse "YOUR CLOUD" (all files) with "SELECTED FILES" (user's scope)
    const selectedFileNames = fileFilter.length > 0
      ? allFiles.filter(f => fileFilter.includes(f.id)).map(f => f.name)
      : [];

    const intent = detectIntent(message, fileFilter.length);

    console.log(`\n💬 ═══ CHAT: "${message.slice(0,80)}" | intent:${intent.type} synthesis:${intent.isSynthesis} | files:${fileFilter.length}`);
    if (selectedFileNames.length > 0) console.log(`   📂 Selected: ${selectedFileNames.join(', ')}`);
    if (userMemory) console.log(`   🧠 Memory: ${(userMemory.match(/^•/gm)||[]).length} facts`);

    const wantsSource = ['why did you','how do you know','what is your source','where did you find',
      'explain your reasoning','how did you conclude','cite your source','what evidence'].some(p => lowerMsg.includes(p));

    const FILE_SCOPED = ['summarize this file','summarize this','summarize the file','what is on page',
      "what's on page",'find key points','key points','list all topics','list topics',
      'what does this file','what is this file','tell me about this file','explain this file'];

    const GENERAL_SIGNALS = ['what is ','what are ','explain ','define ','how does ','how do ',
      'why is ','who is ','when was ','what day','what date','today','time is it',
      'current date','current time'];

    if (noFiles && FILE_SCOPED.some(p => lowerMsg.includes(p)))
      return NextResponse.json({ text: "Please select one or more files from the sidebar first — I don't want to guess which file you mean!" });

    const isPureGeneral = noFiles
      && GENERAL_SIGNALS.some(s => lowerMsg.includes(s))
      && !FILE_SCOPED.some(p => lowerMsg.includes(p));

    // systemState: always shows the full file list for context
    // But the SELECTED FILES block in the prompt overrides it for scoped queries
    const systemState = `Total files: ${allFiles.length}\n${allFiles.map(f => `  • ${f.name} [${f.category}]`).join('\n') || '  None'}`;

    // Retrieve chunks — ONLY from selected files when fileFilter is set
    let rawChunks: any[] = [];
    if (!isPureGeneral) {
      if (fileFilter.length > 0) {
        // ── Strictly fetch ONLY the selected files' chunks ─────────────────
        // For PAGE_SPECIFIC intent, filter at DB level — this is the only
        // reliable approach. JS-level filtering fails when page_number is NULL
        // or when chunk_index estimation is wrong for large documents.
        let dbQuery = supabase
          .from('documents')
          .select('content, metadata, file_id, file_name, file_type, page_number, chunk_index, total_pages, category')
          .in('file_id', fileFilter);

        if (intent.type === 'PAGE_SPECIFIC' && intent.pageNumber !== null) {
          // Try to get chunks for this exact page from DB
          // If page_number column is NULL for these chunks (older uploads),
          // we'll detect the empty result and fall back below
          dbQuery = (dbQuery as any).eq('page_number', intent.pageNumber).limit(6);
          console.log(`   🎯 DB-level page filter: page ${intent.pageNumber}`);
        }

        const { data: primaryData, error } = await dbQuery;

        if (error) return NextResponse.json({ text: `⚠️ DB setup needed. Run NEW_TABLES.sql in Supabase → SQL Editor.` });

        // If page filter returned nothing (page_number is NULL in DB for older files),
        // fall back to fetching ALL chunks — the JS pipeline estimates by chunk_index
        if (intent.type === 'PAGE_SPECIFIC' && (!primaryData || primaryData.length === 0)) {
          console.log(`   ⚠️  page_number filter returned 0 rows — falling back to full fetch + JS estimation`);
          const { data: fallbackData } = await supabase
            .from('documents')
            .select('content, metadata, file_id, file_name, file_type, page_number, chunk_index, total_pages, category')
            .in('file_id', fileFilter);
          rawChunks = fallbackData || [];
        } else {
          rawChunks = primaryData || [];
        }

        if (rawChunks.length === 0) {
          const names = selectedFileNames.map(n => `"${n}"`).join(', ');
          return NextResponse.json({ text: `${names} hasn't been indexed yet. Delete and re-upload it — takes ~30s.` });
        }

        console.log(`   ✅ Fetched ${rawChunks.length} chunks from ${selectedFileNames.length} selected file(s)`);
      } else {
        // No files selected — semantic search across all user's docs
        const embResp = await voyage.embed({ input: [message], model: 'voyage-3', inputType: 'query' });
        const vec     = embResp.data?.[0]?.embedding;
        if (!vec) throw new Error('Embedding failed');
        const { data: matched } = await supabase.rpc('match_all_user_documents', {
          query_embedding: vec, match_threshold: 0.07, match_count: 35, p_user_id: userId
        });
        rawChunks = matched || [];
      }
    }

    const normalized = rawChunks.map(normalizeChunk);

    // ── PAGE_SPECIFIC: dedicated minimal pipeline ─────────────────────────
    // All previous prompt-based fixes failed because the model has 3000 tokens
    // of runway and is trained to be comprehensive. The only reliable solution
    // is to bypass the full pipeline entirely for page queries and use a
    // minimal dedicated flow with a tiny prompt and hard token cap.
    if (intent.type === 'PAGE_SPECIFIC' && intent.pageNumber && fileFilter.length > 0) {
      const pg = intent.pageNumber;
      // rawChunks is already filtered by DB for this page (if page_number was set).
      // For fallback (page_number=NULL in DB), we estimate by chunk_index.
      const sorted = [...normalized].sort((a, b) => a.chunk_index - b.chunk_index);

      let pageChunks: typeof sorted;

      if (normalized.length <= 6) {
        // DB already filtered to this page — use all of them
        pageChunks = sorted;
      } else {
        // Fallback: page_number was NULL, full fetch returned — estimate by chunk_index
        // Use type-safe comparison with Number() to avoid string/number mismatch
        let exact = sorted.filter(c => Number(c.page_number) === pg);
        if (exact.length > 0) {
          pageChunks = exact;
        } else {
          // Chunk_index estimation: average 2 chunks per page
          const est = Math.max(0, (pg - 1) * 2);
          pageChunks = sorted.slice(est, est + 4);
        }
      }

      // Hard cap: 4 chunks max = ~3600 chars — enough for any single page
      const finalPageChunks = pageChunks.slice(0, 4);
      const fileName = finalPageChunks[0]?.file_name ?? selectedFileNames[0] ?? 'document';
      const totalPages = finalPageChunks[0]?.total_pages;

      // Strip the [Page N][Part X/Y] prefixes — model doesn't need them
      const rawPageText = finalPageChunks
        .map(c => c.content.replace(/^\[Page \d+\](\[Part \d+\/\d+\])?\n?/, '').trim())
        .filter(Boolean)
        .join('\n\n');

      if (!rawPageText) {
        // No content found for this page
        const pageInfo = totalPages ? ` (document has ${totalPages} pages)` : '';
        const noContentMsg = `Page ${pg} of "${fileName}"${pageInfo} has no extractable text. It may contain only images or graphics.`;
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'meta', isSynthesis: false, model: FAST_MODEL })}

`));
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'token', token: noContentMsg })}

`));
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'done' })}

`));
            ctrl.close();
          }
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });
      }

      // Minimal system prompt — surgical, no runway for digression
      const pageSystemPrompt = `You are a document reader showing page ${pg} of "${fileName}".
Your ONLY job: present the extracted text below exactly as it appears.
START your response with exactly: "Page ${pg} of \"${fileName}\" contains:"
Then reproduce the text. Nothing before it. Nothing after it.
Do NOT summarise. Do NOT add context. Do NOT reference other pages.
If text is cut off, end with "[page content continues...]"`;

      console.log(`   📄 PAGE_SPECIFIC fast path: page ${pg} of "${fileName}", ${finalPageChunks.length} chunks, ${rawPageText.length} chars`);

      const pageStream = await groq.chat.completions.create({
        model:       FAST_MODEL,
        messages:    [
          { role: 'system', content: pageSystemPrompt },
          { role: 'user',   content: `Here is the extracted text from page ${pg}:

---
${rawPageText}
---

Show this page content. Start with "Page ${pg} of \"${fileName}\" contains:" then the text.` },
        ],
        temperature: 0.0,
        max_tokens:  600,   // hard cap — forces the model to be concise
        stream:      true,
      });

      const enc2 = new TextEncoder();
      let full2 = '';
      const readable2 = new ReadableStream({
        async start(ctrl) {
          ctrl.enqueue(enc2.encode(`data: ${JSON.stringify({ type: 'meta', isSynthesis: false, model: FAST_MODEL })}

`));
          try {
            for await (const chunk of pageStream) {
              const token = chunk.choices[0]?.delta?.content || '';
              if (token) { full2 += token; ctrl.enqueue(enc2.encode(`data: ${JSON.stringify({ type: 'token', token })}

`)); }
            }
          } catch (e: any) {
            ctrl.enqueue(enc2.encode(`data: ${JSON.stringify({ type: 'error', message: e.message })}

`));
          }
          ctrl.enqueue(enc2.encode(`data: ${JSON.stringify({ type: 'done' })}

`));
          ctrl.close();
          console.log(`   ✅ Page ${pg} response: ${full2.length} chars`);
        }
      });
      return new Response(readable2, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });
    }
    // ── End PAGE_SPECIFIC fast path ───────────────────────────────────────

    const selected = selectChunks(normalized, intent, 45);

    // Build the context string — grouped by file, clearly separated
    let retrievedContext = '';
    if (isPureGeneral) {
      retrievedContext = 'NO FILE CONTEXT — General knowledge question. Answer from world knowledge only. Do not reference any files.';
    } else if (selected.length === 0) {
      retrievedContext = 'NO RELEVANT CONTENT FOUND. Ask user to re-select file or rephrase.';
    } else {
      const groups = new Map<string, NormalizedChunk[]>();
      selected.forEach(c => { if (!groups.has(c.file_name)) groups.set(c.file_name, []); groups.get(c.file_name)!.push(c); });
      const sections: string[] = [];
      groups.forEach((chunks, fileName) => {
        const t   = chunks[0].file_type;
        const lbl = t === 'image' ? '🖼️ IMAGE' : t === 'pdf' ? '📕 PDF' : '📘 DOC';
        const pg  = chunks[0].total_pages ? ` — ${chunks[0].total_pages}pp` : '';
        // For page-specific queries, label each chunk with its page number
        const chunkText = intent.type === 'PAGE_SPECIFIC'
          ? chunks.map(c => `[Page ${c.page_number ?? 'unknown'}]\n${c.content}`).join('\n\n')
          : chunks.map(c => c.content).join('\n\n');
        sections.push(`${'═'.repeat(60)}\n[ ${lbl}: "${fileName}"${pg} ]\n${'═'.repeat(60)}\n${chunkText}\n${'═'.repeat(60)}`);
      });
      retrievedContext = sections.join('\n\n');

      // ── FIX: Verify what actually came back matches selected files ───────
      const returnedFiles = [...groups.keys()];
      console.log(`   📋 Files with content: ${returnedFiles.join(', ')}`);
      if (returnedFiles.length !== selectedFileNames.length) {
        console.warn(`   ⚠️ Mismatch: selected ${selectedFileNames.length} files, got content for ${returnedFiles.length}`);
      }
    }

    // ── Web search (runs only when query needs real-time data) ──────────────
    let webSearchBlock = '';
    if (!fileFilter.length && needsWebSearch(message)) {
      console.log(`   🌐 Web search triggered for: "${message.slice(0,60)}"`);
      const results = await searchWeb(message);
      if (results) {
        webSearchBlock = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LIVE WEB SEARCH RESULTS (fetched right now for this query)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Use these results to answer the user's question with up-to-date accuracy.
Cite sources naturally (e.g. "According to ESPN..."). Do NOT make up details.
${results}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        console.log(`   ✅ Web results injected (${results.length} chars)`);
      }
    }

    const finalPrompt = buildSystemPrompt(
      new Date(), userMemory, wantsSource, intent.isSynthesis,
      intent.type === 'COMPARISON',
      selectedFileNames,
      allFiles,
      userEmail,
    )
      .replace('{system_state}', systemState)
      .replace('{retrieved_context}', retrievedContext)
      .replace('{web_search_block}', webSearchBlock);

    const model = intent.isSynthesis ? SYNTHESIS_MODEL : FAST_MODEL;
    console.log(`   🤖 Model: ${model} | intent: ${intent.type}`);

    const cleanHistory = history.slice(-16).map((m: any) => ({
      role:    m.role    as 'user' | 'assistant',
      content: m.content as string,
    }));

    const groqStream = await groq.chat.completions.create({
      model,
      messages:    [{ role: 'system', content: finalPrompt }, ...cleanHistory, { role: 'user', content: message }],
      temperature: intent.isSynthesis ? 0.3 : 0.1,
      max_tokens:  intent.isSynthesis ? 4000 : 3000,
      stream:      true,
    });

    const encoder = new TextEncoder();
    let   fullResponse = '';

    const readable = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ type: 'meta', isSynthesis: intent.isSynthesis, model })}\n\n`
        ));
        try {
          for await (const chunk of groqStream) {
            const token = chunk.choices[0]?.delta?.content || '';
            if (token) {
              fullResponse += token;
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: 'token', token })}\n\n`
              ));
            }
          }
        } catch (streamErr: any) {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ type: 'error', message: streamErr.message })}\n\n`
          ));
        }
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ type: 'done' })}\n\n`
        ));
        controller.close();

        // Fire-and-forget memory save
        if (history.length >= 0 && fullResponse) { // save memory after every exchange
          const conv = [
            ...history.slice(-8).map((m: any) => ({ role: m.role as 'user'|'assistant', content: m.content as string })),
            { role: 'user'      as const, content: message },
            { role: 'assistant' as const, content: fullResponse.slice(0, 400) },
          ];
          const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
          fetch(`${appUrl}/api/memory`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            // userId passed explicitly — memory route accepts it from body
            // because this is a trusted server-to-server call (user already verified above)
            body:    JSON.stringify({ userId, conversation: conv }),
          }).then(r => r.json()).then(d => {
            if (d.factCount !== undefined)
              console.log(`🧠 Memory updated: ${d.factCount} facts`);
          }).catch(e => console.warn('Memory save (non-fatal):', e.message));
        }
        console.log(`   ✅ Stream done: ${fullResponse.length} chars | ${model}`);
      },
    });

    return new Response(readable, {
      headers: {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
      },
    });

  } catch (error: any) {
    console.error('❌ Chat Error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

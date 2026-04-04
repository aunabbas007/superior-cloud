export const dynamic = 'force-dynamic'
// PATH: app/api/files/upload/route.ts
import { createClient }      from '@supabase/supabase-js';
import { getVerifiedUserId } from '@/lib/auth';
import { NextResponse }      from 'next/server';
import { VoyageAIClient }    from 'voyageai';
import pdf                   from 'pdf-parse';
import mammoth               from 'mammoth';
import crypto                from 'crypto';
import { Groq }              from 'groq-sdk';

const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY! });
const groq   = new Groq({ apiKey: process.env.GROQ_API_KEY! });

interface Chunk {
  content:     string;
  page_number: number | null;
  chunk_index: number;
}

// ═════════════════════════════════════════════════════════════════════════════
//
//  CANONICAL CATEGORY SCHEMA  —  Single source of truth
//
//  Every category name here MUST exactly match what's used in:
//    • DOC_SIGNAL_RULES
//    • FILENAME_HINTS
//    • Vision classification prompt
//    • LLM classification prompt
//    • Dashboard CATEGORY_META and COLORS maps
//
//  Schema (per user spec):
//    Group 1  DOCUMENTS & IDENTITY   — text docs, IDs, financials, academic
//    Group 2  SCREENSHOTS & UTILITY  — digital captures, schematics, tickets
//    Group 3  PEOPLE                 — selfies, groups, crowds
//    Group 4  EVENTS                 — activities, gatherings
//    Group 5  PLACES                 — architecture, nature, transit
//    Group 6  OBJECTS                — vehicles, electronics, nature objects
//    Fallback GENERAL
//
// ═════════════════════════════════════════════════════════════════════════════
const KNOWN_CATEGORIES: string[] = [
  // Group 1 – Documents & Identity
  'Government ID', 'Certificate', 'Research Paper', 'University Report',
  'Resume & CV', 'Salary & Pay Slip', 'Bank Statement', 'Tax Document',
  'Receipt & Invoice', 'Medical Record', 'Legal Document', 'Business Report',
  'Handwritten Note',
  // Group 2 – Screenshots & Utility
  'Technical Diagram', 'Code & Tech', 'Travel Ticket', 'QR Code & Barcode',
  'Chat & Conversation', 'Social Media', 'Map & Navigation',
  'Study Notes', 'Data & Dashboard',
  // Group 3 – People
  'Portrait & Selfie', 'Group & Family',
  // Group 4 – Events
  'Personal Event', 'Professional Event',
  // Group 5 – Places
  'Architecture & Building', 'Nature & Landscape', 'Urban & Transit',
  // Group 6 – Objects
  'Vehicle', 'Electronics & Gadget', 'Animals & Wildlife',
  'Food & Beverage', 'Apparel & Fashion',
  // Fallback
  'General',
];

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 0 — FILENAME-BASED HINTS  (free, zero LLM cost)
//
//  FIX #6: The filename is the strongest free signal we have.
//  Users name files like "aadhaar_card.jpg", "salary_slip_march.pdf",
//  "neural_net_diagram.png". We check this first before any model call.
//
//  Rules: keyword list → category. First match wins.
//  Only use keywords that are unambiguous (appear in one category only).
// ─────────────────────────────────────────────────────────────────────────────
const FILENAME_HINTS: { keywords: string[]; category: string }[] = [
  { keywords: ['aadhaar', 'aadhar', 'pan_card', 'pancard', 'voter_id', 'voterid',
               'passport', 'driving_licence', 'driving_license', 'dl_card'],
    category: 'Government ID' },
  { keywords: ['salary_slip', 'payslip', 'pay_slip', 'payroll', 'salary_statement'],
    category: 'Salary & Pay Slip' },
  { keywords: ['bank_statement', 'account_statement', 'passbook'],
    category: 'Bank Statement' },
  { keywords: ['invoice', 'receipt', 'bill_', '_bill', 'tax_invoice', 'gst_invoice'],
    category: 'Receipt & Invoice' },
  { keywords: ['resume', 'cv_', '_cv', 'curriculum_vitae', 'job_application'],
    category: 'Resume & CV' },
  { keywords: ['certificate', 'certification', 'award', 'diploma'],
    category: 'Certificate' },
  { keywords: ['prescription', 'lab_report', 'medical_report', 'discharge_summary',
               'blood_test', 'pathology'],
    category: 'Medical Record' },
  { keywords: ['itr', 'form_16', 'tax_return', 'tds_certificate'],
    category: 'Tax Document' },
  { keywords: ['pnr', 'boarding_pass', 'e_ticket', 'eticket', 'train_ticket',
               'flight_ticket', 'bus_ticket'],
    category: 'Travel Ticket' },
  { keywords: ['neural_net', 'nn_arch', 'uml_diagram', 'er_diagram', 'flowchart',
               'architecture_diagram', 'system_design', 'class_diagram', 'circuit'],
    category: 'Technical Diagram' },
  { keywords: ['screenshot_code', 'code_snippet', 'terminal_output', 'stack_trace'],
    category: 'Code & Tech' },
  { keywords: ['whatsapp', 'telegram_chat', 'chat_screenshot', 'imessage'],
    category: 'Chat & Conversation' },
  { keywords: ['qr_code', 'qrcode', 'barcode', 'upi_qr'],
    category: 'QR Code & Barcode' },
  { keywords: ['wedding', 'birthday_party', 'anniversary', 'graduation_ceremony',
               'engagement'],
    category: 'Personal Event' },
  { keywords: ['conference', 'seminar', 'hackathon', 'meetup', 'workshop'],
    category: 'Professional Event' },
  { keywords: ['selfie', 'profile_photo', 'headshot', 'passport_photo'],
    category: 'Portrait & Selfie' },
  { keywords: ['family_photo', 'group_photo', 'team_photo'],
    category: 'Group & Family' },
];

function classifyByFilename(fileName: string): string | null {
  const lower = fileName.toLowerCase().replace(/[\s\-\.]/g, '_');
  for (const hint of FILENAME_HINTS) {
    if (hint.keywords.some(kw => lower.includes(kw))) {
      console.log(`   📁 Filename hint → "${hint.category}"`);
      return hint.category;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 1 — DOCUMENT SIGNAL RULES  (PDF / DOCX only — never on vision output)
//
//  FIX #4: Removed 'nda' — substring of "amanda", "canada", "panda"
//  FIX #5: Removed bare 'select ' — matches English "please select a candidate"
//          Kept only SQL-specific 'select * from', 'select count('
//
//  Principle: every signal must be EXCLUSIVELY associated with its category.
//  If a signal can appear in any other type of document → remove it.
// ─────────────────────────────────────────────────────────────────────────────
interface SignalRule {
  category:  string;
  signals:   string[];
  minHits:   number;
  exclusive: string[];  // if ANY exclusive word present → skip this rule
}

const DOC_SIGNAL_RULES: SignalRule[] = [

  // ── Group 1: Documents & Identity ─────────────────────────────────────────

  {
    category: 'Government ID',
    signals: [
      // Only identifiers that cannot appear outside a government-issued ID card.
      // Removed: 'date of birth' (on tickets), 'date of issue' (on bank cards/certs),
      //          'date of expiry' (on memberships, credit cards), 'ministry of' (generic)
      'aadhaar', 'aadhar', 'uidai', 'unique identification authority',
      'pan card', 'permanent account number',
      'voter id card', 'voter identity card', 'election commission of india',
      'driving licence', 'driving license number',
      'passport no.', 'passport number',
      'republic of india', 'government of india',
      'unique id:', 'know your customer', 'kyc document',
    ],
    minHits:  1,
    exclusive: ['pnr', 'irctc', 'boarding pass', 'e-ticket', 'seat number',
                'train number', 'flight number', 'booking confirmation',
                'reservation id', 'makemytrip', 'booking id'],
  },

  {
    category: 'Certificate',
    signals: [
      'this is to certify that', 'hereby certify that', 'hereby certifies that',
      'is hereby awarded', 'certificate of completion', 'certificate of achievement',
      'certificate of participation', 'awarded to', 'successfully completed the course',
      'in recognition of', 'with distinction', 'cum laude',
      'bachelor of', 'master of science', 'master of technology',
      'doctor of philosophy', 'diploma of',
    ],
    minHits:  1,
    exclusive: ['boarding pass', 'pnr', 'seat number', 'flight number', 'train number',
                'irctc'],
  },

  {
    category: 'Research Paper',
    signals: [
      // Requires 2 hits — individual words like 'abstract' appear in many docs
      'doi:', 'arxiv:', 'arxiv.org', 'preprint', 'peer-reviewed',
      'et al.,', 'et al.', 'proceedings of', 'journal of',
      'ieee transactions', 'ieee conference', 'springer', 'elsevier', 'acm digital',
      'abstract:', 'keywords:', 'literature review', 'related work',
      'methodology:', 'results:', 'conclusion:', 'references:',
      'statistical significance', 'p-value', 'confidence interval',
      'hypothesis', 'figure 1.', 'table 1.', 'sample size',
    ],
    minHits:  2,
    exclusive: [],
  },

  {
    category: 'University Report',
    signals: [
      'submitted in partial fulfillment', 'final year project', 'capstone project',
      'internship report', 'under the guidance of', 'guided by prof',
      'guided by dr.', 'roll number', 'enrollment number',
      'department of computer', 'department of electronics',
      'department of mechanical', 'department of civil',
      'faculty of engineering', 'affiliated to', 'academic year',
      'semester project', 'term paper', 'submitted to the department',
    ],
    minHits:  2,
    exclusive: [],
  },

  {
    category: 'Resume & CV',
    signals: [
      'curriculum vitae', 'career objective', 'professional summary',
      'work experience', 'employment history', 'professional experience',
      'key skills', 'technical skills', 'core competencies',
      'linkedin.com/in/', 'current ctc', 'expected ctc', 'notice period',
      'references available', 'years of experience',
      'job description', 'roles and responsibilities',
      'job title', 'job location', 'reporting to',
    ],
    minHits:  2,
    exclusive: [],
  },

  {
    category: 'Salary & Pay Slip',
    signals: [
      'salary slip', 'payslip', 'pay slip', 'pay stub',
      'net salary', 'gross salary', 'basic salary',
      'provident fund', 'pf deduction', 'tds deducted',
      'net pay', 'total deductions', 'take home pay',
      'house rent allowance', 'employee id', 'pay period',
    ],
    minHits:  2,
    exclusive: [],
  },

  {
    category: 'Bank Statement',
    signals: [
      'bank statement', 'account statement', 'account number',
      'ifsc code', 'ifsc:', 'opening balance', 'closing balance',
      'transaction date', 'neft', 'rtgs', 'imps', 'upi transfer',
      'cheque number', 'credit', 'debit',
    ],
    minHits:  3,  // 'credit' and 'debit' appear widely; need co-occurrence
    exclusive: [],
  },

  {
    category: 'Tax Document',
    signals: [
      'income tax return', 'itr-1', 'itr-2', 'itr-3', 'itr-4',
      'form 16', 'form16', 'assessment year', 'tds certificate',
      'taxable income', 'tax payable', 'refund due',
      'income tax department', 'challan number', 'tan:',
      'deductor name', 'gross total income',
    ],
    minHits:  2,
    exclusive: [],
  },

  {
    category: 'Receipt & Invoice',
    signals: [
      'invoice no.', 'invoice number', 'invoice date',
      'bill to:', 'billed to:', 'ship to:',
      'receipt no.', 'receipt number', 'gstin', 'gst number',
      'subtotal', 'total amount', 'tax invoice',
      'purchase order', 'unit price', 'amount due',
      'payment received', 'order id',
    ],
    minHits:  2,
    exclusive: [],
  },

  {
    category: 'Medical Record',
    signals: [
      'prescription', 'rx:', 'patient name:', 'patient id:',
      'diagnosis:', 'lab report', 'blood test', 'pathology report',
      'radiology report', 'mri report', 'ct scan report',
      'ultrasound report', 'discharge summary', 'opd', 'ipd',
      'twice daily', 'once daily', 'thrice daily',
    ],
    minHits:  2,
    exclusive: [],
  },

  {
    category: 'Legal Document',
    signals: [
      'this agreement', 'whereas,', 'party of the first part',
      // FIX #4: Removed 'nda' — substring of "amanda", "panda", "canada"
      //         Kept the full phrase which is unambiguous.
      'non-disclosure agreement', 'terms and conditions',
      'governing law', 'jurisdiction:', 'indemnify', 'affidavit',
      'notary public', 'power of attorney', 'legal notice',
      'sworn statement', 'hereby agrees',
    ],
    minHits:  2,
    exclusive: [],
  },

  {
    category: 'Business Report',
    signals: [
      'executive summary', 'quarterly report', 'annual report',
      'market analysis', 'business proposal', 'request for proposal',
      'scope of work', 'meeting minutes', 'action items', 'agenda:',
      'memorandum', 'internal memo', 'stakeholder', 'kpi', 'roi analysis',
    ],
    minHits:  2,
    exclusive: [],
  },

  {
    category: 'Handwritten Note',
    // NOTE: mammoth and pdf-parse cannot extract actual handwritten content
    // so these signals will almost never fire for PDFs/DOCX. They exist as
    // a safety net for documents that explicitly self-describe as handwritten.
    signals: [
      'handwritten note', 'handwritten text', 'hand-written document',
      'notebook page', 'diary entry', 'sticky note', 'written by hand',
    ],
    minHits:  1,
    exclusive: ['neural network', 'diagram', 'flowchart', 'architecture',
                'layers', 'nodes', 'circuit', 'schematic', 'uml'],
  },

  // ── Group 2: Screenshots & Utility ────────────────────────────────────────

  {
    category: 'Technical Diagram',
    signals: [
      'neural network', 'convolutional neural network', 'recurrent neural network',
      'lstm', 'transformer architecture', 'attention mechanism',
      'input layer', 'hidden layer', 'output layer', 'activation function',
      'backpropagation', 'gradient descent', 'training accuracy', 'validation loss',
      'system architecture', 'class diagram', 'uml diagram', 'entity relationship',
      'er diagram', 'data flow diagram', 'network topology', 'circuit diagram',
      'flowchart', 'sequence diagram', 'schematic diagram',
    ],
    minHits:  2,
    exclusive: [],
  },

  {
    category: 'Code & Tech',
    signals: [
      // FIX #5: Replaced bare 'select ' with explicit SQL patterns only
      'select * from', 'select count(', 'select id from', 'select name from',
      'create table', 'insert into', 'alter table', 'drop table',
      'inner join', 'left join', 'group by', 'order by', 'primary key', 'foreign key',
      'import numpy', 'import pandas', 'import torch', 'import tensorflow',
      'from sklearn', 'import react', 'async function',
      'def ', 'class ', 'return {', '=> {',
      'api endpoint', 'rest api', 'graphql', 'json schema',
      'docker', 'kubernetes', 'git commit', 'pull request',
      'traceback (most recent', 'uncaught typeerror', 'syntax error:',
      'npm err', 'http 404', 'http 500',
    ],
    minHits:  2,
    exclusive: [],
  },

  {
    category: 'Travel Ticket',
    signals: [
      'pnr', 'pnr number', 'pnr no', 'boarding pass',
      'e-ticket', 'eticket', 'seat no.', 'seat number',
      'coach number', 'berth', 'gate number',
      'train number', 'flight number',
      'irctc', 'makemytrip', 'goibibo', 'cleartrip', 'yatra',
      'booking confirmation', 'booking id', 'reservation id',
      'passenger name', 'class: sleeper', 'class: ac', 'bookmyshow',
    ],
    minHits:  2,
    exclusive: [],
  },

  {
    category: 'Chat & Conversation',
    signals: [
      'whatsapp', 'imessage', 'telegram chat', 'discord server',
      'last seen at', 'read receipt', 'typing...', 'group chat',
      'direct message', 'slack channel', 'voice call ended',
    ],
    minHits:  2,
    exclusive: ['certificate', 'abstract:', 'invoice', 'doi:'],
  },

  {
    category: 'Data & Dashboard',
    signals: [
      'pie chart', 'bar chart', 'line graph', 'scatter plot',
      'histogram', 'kpi dashboard', 'conversion rate', 'bounce rate',
      'google analytics', 'power bi', 'tableau', 'data studio',
    ],
    minHits:  2,
    exclusive: [],
  },

  {
    category: 'Vehicle',
    signals: [
      'registration number', 'vehicle registration', 'rc book',
      'vehicle identification number', 'engine number', 'chassis number',
      'motor vehicle', 'insurance policy number', 'road tax',
    ],
    minHits:  2,
    exclusive: [],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
function classifyDocumentText(text: string): string | null {
  const lower = text.toLowerCase();
  for (const rule of DOC_SIGNAL_RULES) {
    if (rule.exclusive.some(ex => lower.includes(ex))) continue;
    const hits = rule.signals.filter(sig => lower.includes(sig)).length;
    if (hits >= rule.minHits) {
      console.log(`   ⚡ Signal match → "${rule.category}" (${hits}/${rule.minHits} hits)`);
      return rule.category;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 2 — VISION: CLASSIFY THEN EXTRACT  (two separate calls)
//
//  FIX #1: Split into TWO separate model calls:
//
//    Call A — Classification only (max_tokens: 60)
//      Returns ONLY: {"category": "Travel Ticket", "confidence": "HIGH"}
//      Short output = laser focus, no attention drift.
//      Model cannot ramble, cannot hedge with "or possibly...".
//
//    Call B — Content extraction for embeddings (max_tokens: 2000)
//      Returns OCR text, description, key entities.
//      NO classification here — that's already done.
//
//  This is the architectural fix that eliminates the class of bugs where:
//    • Category field gets buried inside long OCR output
//    • Model writes "Travel Ticket or possibly Government ID"
//    • .includes() finds "Government ID" first (it's index 0) and wins
//
//  FIX #7: Confidence check — if confidence is LOW, we run LLM second opinion.
// ─────────────────────────────────────────────────────────────────────────────

const VISION_CLASSIFY_SYSTEM = `You are a file classification expert. You will be shown an image. Your ONLY job is to assign it to exactly ONE category from the list provided.

CLASSIFICATION SCHEMA (read all rules before deciding):

GROUP 1 — DOCUMENTS & IDENTITY  (text-heavy, formal, reading/verification intent):
  "Government ID"     → Aadhaar, PAN card, Voter ID, Passport, Driving Licence. Must show a government seal and official ID number. A travel ticket that prints passenger DOB is NOT this.
  "Certificate"       → Completion/achievement/degree certificate. "This is to certify", "awarded to", "successfully completed".
  "Research Paper"    → Academic paper: abstract, DOI, methodology, references sections.
  "University Report" → Project/internship report for a department. Roll number, guided by.
  "Resume & CV"       → Work experience, skills, career objective. Job descriptions also go here.
  "Salary & Pay Slip" → Net salary, gross salary, PF, TDS, take-home. Employee payroll.
  "Bank Statement"    → Account number, IFSC, rows of transactions with credit/debit.
  "Tax Document"      → ITR, Form 16, assessment year, TDS certificate.
  "Receipt & Invoice" → Invoice number, GSTIN, bill to, subtotal, amount due.
  "Medical Record"    → Prescription, lab report, patient name, diagnosis, discharge summary.
  "Legal Document"    → Agreement, NDA, affidavit, power of attorney, contract.
  "Business Report"   → Executive summary, quarterly/annual report, meeting minutes.
  "Handwritten Note"  → The ENTIRE primary content is handwritten on paper/notebook. A diagram, chart, or schematic that has handwritten labels IS NOT this — that is Technical Diagram.

GROUP 2 — SCREENSHOTS & UTILITY  (digital captures, schematics, code):
  "Technical Diagram" → Neural network architecture, ML model diagram, UML, ER diagram, flowchart, circuit schematic, system architecture. USE THIS even if it has hand-drawn style or annotations.
  "Code & Tech"       → Source code, SQL queries, terminal/command line output, error logs, stack traces.
  "Travel Ticket"     → PNR number, boarding pass, seat/berth number, train/flight/event ticket. A ticket showing passenger date of birth is STILL a Travel Ticket, NOT a Government ID.
  "QR Code & Barcode" → QR payment code, product barcode, UPI QR.
  "Chat & Conversation" → WhatsApp, Telegram, iMessage, Discord, Slack chat interface screenshot.
  "Social Media"      → Instagram, Twitter/X, Facebook, Reddit, LinkedIn post/feed screenshot.
  "Map & Navigation"  → Google Maps, Apple Maps, route/directions screenshot.
  "Study Notes"       → Lecture notes, question paper, exam paper, syllabus.
  "Data & Dashboard"  → Analytics dashboard, charts, KPIs, graphs, metrics screenshot.

GROUP 3 — PEOPLE: "Portrait & Selfie" (one person, face-focused) | "Group & Family" (2+ people)
GROUP 4 — EVENTS: "Personal Event" (wedding/birthday/festival/celebration) | "Professional Event" (conference/seminar/hackathon/meeting)
GROUP 5 — PLACES: "Architecture & Building" | "Nature & Landscape" | "Urban & Transit"
GROUP 6 — OBJECTS: "Vehicle" | "Electronics & Gadget" | "Animals & Wildlife" | "Food & Beverage" | "Apparel & Fashion"
FALLBACK: "General" — ONLY if truly nothing above fits.

DISAMBIGUATION RULES (common confusions):
• Neural network diagram WITH hand-drawn labels/annotations → "Technical Diagram" (not "Handwritten Note")
• Whiteboard drawing of a flowchart → "Technical Diagram" (not "Handwritten Note")
• IRCTC/airline ticket showing passenger DOB → "Travel Ticket" (not "Government ID")
• Job posting / job description → "Resume & CV" (not any other category)
• A certificate of completion → "Certificate" (not "Government ID")
• Scanned handwritten essay → "Handwritten Note"
• Architecture blueprint/schematic → "Technical Diagram"
• Photo of a person with a birthday cake → "Personal Event" (not "Portrait & Selfie")
• Photo of a mountain / forest / beach → "Nature & Landscape"
• Photo of the Eiffel Tower / temple / building → "Architecture & Building"

You MUST respond with ONLY valid JSON. No explanation. No preamble. No markdown.
Format: {"category": "<exact category name>", "confidence": "<HIGH|MEDIUM|LOW>"}`;

const VISION_EXTRACT_SYSTEM = `You are an expert document and image analyst. Extract all information from the provided image thoroughly and accurately.`;

const buildVisionExtractPrompt = (fileName: string): string =>
  `Analyze this image: "${fileName}"

Extract ALL of the following:

OCR_TEXT: [Copy every single word, number, label, and character visible in the image exactly as it appears. Preserve layout where possible.]

DESCRIPTION: [Describe what is shown — layout, structure, visual elements, colors, logos, people, objects, chart types, diagram components, UI elements.]

KEY_ENTITIES: [List every specific piece of information: names, ID numbers, dates, monetary amounts, addresses, organizations, URLs, product names, measurements, error codes, etc.]

Be exhaustive. Missing text means missed search results later.`;

async function analyzeImageAndClassify(
  buffer:   Buffer,
  fileType: string,
  fileName: string,
): Promise<{
  chunks:          Chunk[];
  visionCategory:  string | null;
  confidence:      'HIGH' | 'MEDIUM' | 'LOW' | null;
}> {
  const visionModels = [
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'meta-llama/llama-4-maverick-17b-128e-instruct',
  ];

  const base64Image  = buffer.toString('base64');
  const imagePayload = { type: 'image_url' as const, image_url: { url: `data:${fileType};base64,${base64Image}` } };

  let visionCategory: string | null  = null;
  let confidence:     'HIGH' | 'MEDIUM' | 'LOW' | null = null;
  let extractionText  = '';

  // ── CALL A: Classification only ──────────────────────────────────────────
  // FIX #1: max_tokens=60. The model ONLY outputs {"category":"...","confidence":"..."}
  // No OCR, no description. Short output = no attention drift = reliable category.
  // FIX #3: JSON output. Parsed exactly. No .includes() ambiguity.
  for (const modelId of visionModels) {
    try {
      const resp = await groq.chat.completions.create({
        model: modelId,
        messages: [
          { role: 'system', content: VISION_CLASSIFY_SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Classify this image file: "${fileName}". Return ONLY JSON.` },
              imagePayload,
            ],
          },
        ],
        temperature:     0.0,
        max_tokens:      60,   // just the JSON object
        response_format: { type: 'json_object' },
      });

      const raw = resp.choices[0].message.content ?? '';
      const parsed = JSON.parse(raw);

      // Exact match first, then case-insensitive
      const catRaw     = (parsed.category ?? '').trim();
      const confRaw    = ((parsed.confidence ?? '') as string).toUpperCase();
      const exactMatch = KNOWN_CATEGORIES.find(c => c === catRaw);
      const fuzzyMatch = exactMatch ?? KNOWN_CATEGORIES.find(
        c => c.toLowerCase() === catRaw.toLowerCase()
      );

      if (fuzzyMatch) {
        visionCategory = fuzzyMatch;
        confidence     = (['HIGH', 'MEDIUM', 'LOW'] as const).includes(confRaw as any)
          ? (confRaw as 'HIGH' | 'MEDIUM' | 'LOW')
          : 'MEDIUM';
        console.log(`   🎯 Vision classify [${modelId}]: "${visionCategory}" (${confidence})`);
        break;
      } else {
        console.warn(`   ⚠️  Vision returned unknown category: "${catRaw}"`);
      }
    } catch (err: any) {
      console.warn(`   ⚠️  Vision classify [${modelId}] failed: ${err.message}`);
    }
  }

  // ── CALL B: Content extraction for embeddings ────────────────────────────
  // FIX #1: Separate call, no classification burden. Model focuses entirely
  // on extracting OCR text and entities — which is what embeddings need.
  const extractPrompt = buildVisionExtractPrompt(fileName);
  for (const modelId of visionModels) {
    try {
      const resp = await groq.chat.completions.create({
        model: modelId,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: extractPrompt },
            imagePayload,
          ],
        }],
        temperature: 0.1,
        max_tokens:  2000,
      });
      extractionText = resp.choices[0].message.content ?? '';
      console.log(`   📄 Vision extract [${modelId}]: ${extractionText.length} chars`);
      break;
    } catch (err: any) {
      console.warn(`   ⚠️  Vision extract [${modelId}] failed: ${err.message}`);
    }
  }

  if (!extractionText) {
    extractionText = `[IMAGE: ${fileName}]\nContent extraction unavailable.`;
  }

  // Build chunks from extraction text
  const fullText   = `[IMAGE: ${fileName}]\n${extractionText}`;
  const CHUNK_SIZE = 900;
  const chunks: Chunk[] = [];
  for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
    chunks.push({ content: fullText.slice(i, i + CHUNK_SIZE), page_number: null, chunk_index: chunks.length });
  }

  return { chunks, visionCategory, confidence };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP 3 — LLM FALLBACK CLASSIFIER
//
//  FIX #2: Upgraded from llama-3.1-8b-instant → llama-3.3-70b-versatile.
//          70B has dramatically better instruction following. It reliably
//          outputs the exact category name from our list.
//
//  FIX #3: JSON output format. Parse exactly. No .includes() ambiguity.
//          model outputs: {"category": "Travel Ticket"}
//
//  Used when:
//    (a) Document signal matching returns null
//    (b) Vision classification failed (model error)
//    (c) Vision confidence is LOW (FIX #7)
//
//  Few-shot examples cover every historically misclassified pattern,
//  injected directly into the user message (not just system prompt).
// ─────────────────────────────────────────────────────────────────────────────

const LLM_CLASSIFY_SYSTEM = `You are a precise file categorization system. Classify the given content into exactly one category from the provided list.

VALID CATEGORIES:
${KNOWN_CATEGORIES.map((c, i) => `${i + 1}. "${c}"`).join('\n')}

CRITICAL DISAMBIGUATION RULES:
• A travel ticket (PNR, boarding pass, seat number) that shows passenger DOB → "Travel Ticket" NOT "Government ID"
• A neural network / ML architecture / UML / flowchart diagram → "Technical Diagram" even if it has hand-drawn labels
• A job description / job posting → "Resume & CV"
• A certificate with "awarded to" / "this is to certify" → "Certificate" NOT "Government ID"
• An entire document written in handwriting on paper → "Handwritten Note"
• A diagram on a whiteboard with handwritten labels → "Technical Diagram" NOT "Handwritten Note"

Return ONLY valid JSON. No explanation. No preamble.
Format: {"category": "<exact category name from list>"}`;

const FEW_SHOT_EXAMPLES = `
CLASSIFICATION EXAMPLES (study these before classifying):

Input: "IRCTC e-Ticket | PNR: 4567890123 | Passenger: Rahul Sharma | DOB: 01-Jan-1995 | Train: 12345 Rajdhani | Seat: S4/32 | Departure: New Delhi | Arrival: Mumbai | Class: Sleeper"
Output: {"category": "Travel Ticket"}
[PNR + seat number = ticket. DOB on a ticket is NOT a Government ID signal.]

Input: "[IMAGE] Neural network architecture diagram. Input layer connected to 3 hidden layers. Each node has weighted edges. Labels show w1, w2 weights. Some annotations appear hand-drawn. Backpropagation arrows visible."
Output: {"category": "Technical Diagram"}
[Primary content is a neural network. Hand-drawn annotations do not change the category.]

Input: "Job Description: Senior Software Engineer | Responsibilities: Design scalable backend systems. Written communication skills required. Technical skills: Python, ML, SQL | CTC: 20 LPA | Notice: 30 days"
Output: {"category": "Resume & CV"}
[Job descriptions are Resume & CV. Generic words like 'written' are NOT handwriting signals.]

Input: "This is to certify that Priya Sharma has successfully completed Advanced Machine Learning with distinction. Awarded on 15 March 2026. Signed: Director, IIT Bombay."
Output: {"category": "Certificate"}
["This is to certify" + "successfully completed" = Certificate.]

Input: "Abstract: This paper proposes a novel transformer architecture for NLP. Keywords: attention, BERT. DOI: 10.1234/abc. References: [1] Vaswani et al., 2017."
Output: {"category": "Research Paper"}

Input: "Salary Slip — March 2026 | Employee: Vikram Nair | Basic: ₹45,000 | HRA: ₹18,000 | PF Deduction: ₹5,400 | TDS: ₹3,200 | Net Pay: ₹54,400"
Output: {"category": "Salary & Pay Slip"}

Input: "Project Report submitted to Department of Computer Science, XYZ University. By: Arjun Patel, Roll No CS2021045. Under guidance of Prof. Meera Singh. Academic Year: 2025-26."
Output: {"category": "University Report"}

Input: "Aadhaar Card | Unique Identification Authority of India | 1234 5678 9012 | Government of India"
Output: {"category": "Government ID"}

Input: "[IMAGE] WhatsApp chat screenshot. Contact: Ananya. Last seen today at 3:45 PM. Read receipt. Typing indicator visible."
Output: {"category": "Chat & Conversation"}

Input: "[IMAGE] Whiteboard with a flowchart. Boxes and arrows showing software deployment pipeline. Some text is handwritten in marker. Steps: Build → Test → Stage → Deploy."
Output: {"category": "Technical Diagram"}
[A flowchart on a whiteboard = Technical Diagram, even if text is hand-drawn.]

NOW CLASSIFY THE FOLLOWING:`;

async function classifyWithLLM(
  content:  string,
  context:  string,  // e.g. 'IMAGE: neural_net.png' or 'PDF: resume.pdf'
): Promise<string> {
  try {
    const userMsg =
      FEW_SHOT_EXAMPLES +
      `\n\nContext: ${context}\n\nContent:\n` +
      content.slice(0, 3500) +
      '\n\nReturn ONLY JSON: {"category": "..."}';

    // FIX #2: Use 70B model instead of 8B for dramatically better accuracy
    const resp = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: LLM_CLASSIFY_SYSTEM },
        { role: 'user',   content: userMsg },
      ],
      temperature:     0.0,
      max_tokens:      40,
      // FIX #3: JSON output — no ambiguity, no .includes() matching needed
      response_format: { type: 'json_object' },
    });

    const raw    = resp.choices[0].message.content ?? '';
    const parsed = JSON.parse(raw);
    const catRaw = (parsed.category ?? '').trim();

    // Exact match first
    const exact = KNOWN_CATEGORIES.find(c => c === catRaw);
    if (exact) {
      console.log(`   🤖 LLM (70B) → "${exact}"`);
      return exact;
    }

    // Case-insensitive fallback
    const fuzzy = KNOWN_CATEGORIES.find(c => c.toLowerCase() === catRaw.toLowerCase());
    if (fuzzy) {
      console.log(`   🤖 LLM (70B) fuzzy → "${fuzzy}"`);
      return fuzzy;
    }

    console.warn(`   🤖 LLM (70B) returned unknown: "${catRaw}" → General`);
    return 'General';

  } catch (err: any) {
    console.warn(`   LLM fallback failed: ${err.message}`);
    return 'General';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TAG GENERATOR  (uses 8B for speed — tags don't need precision classification)
// ─────────────────────────────────────────────────────────────────────────────
async function generateTags(
  category:    string,
  fileName:    string,
  textSnippet: string,
): Promise<string[]> {
  try {
    const resp = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'Return ONLY valid JSON: {"tags": ["tag-one", "tag-two"]}. '
                 + '2–4 lowercase hyphenated descriptive tags for this file. No explanation.',
        },
        {
          role: 'user',
          content: `Category: "${category}". File name: "${fileName}".\n\n`
                 + textSnippet.slice(0, 1200),
        },
      ],
      model:           'llama-3.1-8b-instant',
      response_format: { type: 'json_object' },
      temperature:     0.1,
      max_tokens:      80,
    });
    const parsed = JSON.parse(resp.choices[0].message.content || '{}');
    return Array.isArray(parsed.tags) ? parsed.tags.slice(0, 4) : [];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PDF EXTRACTION — uses pagerender callback for correct per-page extraction
//
//  WHY NOT split('\f'):
//  Many PDFs use \f (form feed) as bullet/special chars, not page breaks.
//  split('\f') gives wrong page boundaries — all content lands on "page 1".
//
//  FIX: pdf-parse's pagerender callback fires once PER ACTUAL PAGE and
//  gives us the text content of that exact page — no \f ambiguity.
// ─────────────────────────────────────────────────────────────────────────────
async function extractPDFChunks(
  buffer: Buffer,
): Promise<{ chunks: Chunk[]; pageCount: number }> {

  // Collect per-page text via pagerender callback
  const pageTexts: string[] = [];

  const pagerender = (pageData: any): Promise<string> =>
    pageData.getTextContent({ normalizeWhitespace: true })
      .then((content: any) => {
        // Join all text items on this page into one string
        const text = content.items
          .map((item: any) => item.str)
          .join(' ')
          .trim();
        pageTexts.push(text);
        return text;
      });

  const pdfData  = await pdf(buffer, { pagerender });
  const pageCount = pdfData.numpages;

  // Fallback: if pagerender didn't fire (some edge-case PDFs),
  // split the full text evenly across pages
  if (pageTexts.length === 0 && pdfData.text) {
    console.warn('   pagerender returned no pages — using even text split');
    const fullText = pdfData.text.replace(/\f/g, ' ').trim();
    const charsPerPage = Math.ceil(fullText.length / Math.max(pageCount, 1));
    for (let i = 0; i < pageCount; i++) {
      pageTexts.push(fullText.slice(i * charsPerPage, (i + 1) * charsPerPage).trim());
    }
  }

  const chunks: Chunk[] = [];
  const CHUNK_SIZE = 900;

  for (let i = 0; i < pageCount; i++) {
    const pageNum = i + 1;
    const clean   = (pageTexts[i] ?? '').trim();

    if (!clean || clean.length < 5) {
      chunks.push({
        content:     `[Page ${pageNum}] This page contains images or no extractable text.`,
        page_number: pageNum,
        chunk_index: chunks.length,
      });
      continue;
    }

    const subs: string[] = [];
    for (let j = 0; j < clean.length; j += CHUNK_SIZE) {
      subs.push(clean.slice(j, j + CHUNK_SIZE).trim());
    }

    subs.forEach((sub, si) => {
      if (!sub) return;
      chunks.push({
        content: subs.length > 1
          ? `[Page ${pageNum}][Part ${si + 1}/${subs.length}]\n${sub}`
          : `[Page ${pageNum}]\n${sub}`,
        page_number: pageNum,
        chunk_index: chunks.length,
      });
    });
  }

  console.log(`📕 PDF: ${pageCount} pages → ${chunks.length} chunks (pagerender)`);
  return { chunks, pageCount };
}

// ─────────────────────────────────────────────────────────────────────────────
//  MASTER CLASSIFICATION ORCHESTRATOR
//
//  Full decision tree:
//
//  ALL FILES:
//    Step 0 → Filename hints  (free, instant)
//             If match → done ✅
//
//  IMAGES:
//    Step 1 → Vision model classify-only call (JSON, max_tokens=60)
//             If HIGH/MEDIUM confidence → done ✅
//             If LOW confidence → run LLM second opinion on extracted text
//             If model error → run LLM on extracted text
//
//  DOCUMENTS (PDF/DOCX):
//    Step 1 → Signal matching on real extracted text
//             If match → done ✅
//             If no match → LLM fallback
//
//  LLM FALLBACK (all types):
//    Uses llama-3.3-70b-versatile + JSON output + few-shot examples
// ─────────────────────────────────────────────────────────────────────────────
async function determineCategory(
  chunks:       Chunk[],
  isImage:      boolean,
  fileName:     string,
  visionResult: { category: string | null; confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null },
): Promise<string> {

  const fullText = chunks.map(c => c.content).join(' ');

  // Step 0: Filename hint (fastest, no model needed)
  const filenameCategory = classifyByFilename(fileName);
  if (filenameCategory) return filenameCategory;

  if (isImage) {
    const { category: visCat, confidence } = visionResult;

    // Vision gave a confident answer → use it
    if (visCat && (confidence === 'HIGH' || confidence === 'MEDIUM')) {
      return visCat;
    }

    // FIX #7: Vision gave LOW confidence → run LLM as second opinion
    if (visCat && confidence === 'LOW') {
      console.log(`   🔍 Vision LOW confidence ("${visCat}") → LLM second opinion`);
      const llmResult = await classifyWithLLM(fullText, `IMAGE: ${fileName}`);
      // If LLM disagrees with LOW confidence vision result → trust LLM
      if (llmResult !== 'General' && llmResult !== visCat) {
        console.log(`   ↩️  LLM overrides LOW confidence vision: "${visCat}" → "${llmResult}"`);
        return llmResult;
      }
      // LLM agrees or is General → keep vision result
      return visCat;
    }

    // Vision completely failed → LLM on extracted text
    console.log(`   Vision failed — LLM fallback on extracted text`);
    return classifyWithLLM(fullText, `IMAGE: ${fileName}`);
  }

  // Document pipeline
  const signalResult = classifyDocumentText(fullText);
  if (signalResult) return signalResult;

  // Signals ambiguous → LLM
  console.log(`   Signals ambiguous — LLM fallback (70B)`);
  return classifyWithLLM(fullText, `DOCUMENT: ${fileName}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN UPLOAD HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export async function POST(req: Request) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  try {
    const { userId, error: authError } = await getVerifiedUserId(req);
    if (authError) return authError;

    const formData = await req.formData();
    const file     = formData.get('file') as File;
    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

    const fileType = file.type;
    console.log(`\n${'═'.repeat(54)}`);
    console.log(`UPLOAD: "${file.name}"  [${fileType}]`);
    console.log(`${'═'.repeat(54)}`);

    const arrayBuffer = await file.arrayBuffer();
    const buffer      = Buffer.from(arrayBuffer);
    const checksum    = crypto.createHash('sha256').update(buffer).digest('hex');

    // ── Deduplication ────────────────────────────────────────────────────────
    const { data: dupe } = await supabase
      .from('files')
      .select('id, name')
      .eq('checksum', checksum)
      .eq('user_id', userId)
      .maybeSingle();

    if (dupe) {
      console.log(`♻️  Duplicate → "${dupe.name}"`);
      return NextResponse.json({
        success: true, isDuplicate: true,
        existingName: dupe.name,
        message: `This file already exists as "${dupe.name}".`,
      });
    }

    // ── Name conflict ─────────────────────────────────────────────────────────
    const baseName = file.name.replace(/\.[^.]+$/, '');
    const { data: nameConflicts } = await supabase
      .from('files').select('name').eq('user_id', userId)
      .ilike('name', `${baseName}%`);

    let finalFileName = file.name;
    if (nameConflicts?.length) {
      const existing = nameConflicts.map((f: { name: string }) => f.name);
      if (existing.includes(file.name)) {
        const ext = file.name.includes('.') ? '.' + file.name.split('.').pop() : '';
        let n = 2;
        while (existing.includes(`${baseName} (${n})${ext}`)) n++;
        finalFileName = `${baseName} (${n})${ext}`;
        console.log(`📝 Renamed → "${finalFileName}"`);
      }
    }

    // ── Extract + Classify ────────────────────────────────────────────────────
    let chunks: Chunk[]                   = [];
    let pageCount: number | null          = null;
    const isImage                         = fileType.startsWith('image/');
    let visionResult: { category: string | null; confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null } =
      { category: null, confidence: null };

    if (isImage) {
      const result = await analyzeImageAndClassify(buffer, fileType, finalFileName);
      chunks        = result.chunks;
      visionResult  = { category: result.visionCategory, confidence: result.confidence };

    } else if (fileType === 'application/pdf') {
      const result = await extractPDFChunks(buffer);
      chunks    = result.chunks;
      pageCount = result.pageCount;

    } else if (
      fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      const result     = await mammoth.extractRawText({ buffer });
      const text       = result.value.trim();
      const CHUNK_SIZE = 900;
      for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        chunks.push({ content: text.slice(i, i + CHUNK_SIZE), page_number: null, chunk_index: chunks.length });
      }
      console.log(`📘 DOCX: ${chunks.length} chunks`);

    } else {
      return NextResponse.json(
        { error: 'Unsupported file type. Upload PDF, DOCX, PNG, JPG, or JPEG.' },
        { status: 400 },
      );
    }

    if (chunks.length === 0) {
      return NextResponse.json({ error: 'Could not extract content from file.' }, { status: 400 });
    }

    // ── Determine final category ──────────────────────────────────────────────
    const finalCategory = await determineCategory(chunks, isImage, finalFileName, visionResult);
    const textForTags   = chunks.map(c => c.content).join(' ');
    const tags          = await generateTags(finalCategory, finalFileName, textForTags);

    console.log(`\n✅ CLASSIFIED: "${finalCategory}"  |  tags: [${tags.join(', ')}]`);

    const fileId    = crypto.randomUUID();
    const bucketPath = `${userId}/${fileId}/${finalFileName}`;

    // ── Upload to Supabase Storage (actual file) ──────────────────────────────
    // This stores the original file so users can download it later.
    // Bucket: 'user-files' (must be created as PRIVATE in Supabase dashboard)
    let storageBucketPath: string | null = null;
    try {
      const { error: storageErr } = await supabase.storage
        .from('user-files')
        .upload(bucketPath, buffer, {
          contentType: fileType,
          upsert:      false,
        });
      if (storageErr) {
        console.warn(`   ⚠️  Storage upload failed (non-fatal): ${storageErr.message}`);
        // Non-fatal: file is still indexed and searchable, just can't download original
      } else {
        storageBucketPath = bucketPath;
        console.log(`   ☁️  Stored in bucket: ${bucketPath}`);
      }
    } catch (storageEx: any) {
      console.warn(`   ⚠️  Storage exception (non-fatal): ${storageEx.message}`);
    }

    // ── DB insert ─────────────────────────────────────────────────────────────
    const { error: fileErr } = await supabase.from('files').insert({
      id:                  fileId,
      name:                finalFileName,
      user_id:             userId,
      size:                file.size,
      type:                fileType,
      storage_path:        `u/${userId}/${fileId}/${finalFileName}`,
      storage_bucket_path: storageBucketPath,
      checksum,
      category:            finalCategory,
      tags,
    });
    if (fileErr) throw new Error(fileErr.message);

    // ── Log classification (non-fatal — for accuracy tracking) ────────────────
    // Use void + async IIFE so we can await without blocking the upload response
    void (async () => {
      try {
        await supabase.from('classification_log').insert({
          file_id:     fileId,
          user_id:     userId,
          ai_category: finalCategory,
          confidence:  isImage ? visionResult.confidence : null,
          method:      isImage
            ? (visionResult.category ? 'vision' : 'llm')
            : 'signal',
        });
      } catch { /* non-fatal — never block upload */ }
    })();

    // ── Embeddings ────────────────────────────────────────────────────────────
    const BATCH_SIZE = 64;
    let   embedded   = 0;

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch    = chunks.slice(i, i + BATCH_SIZE);
      const embResp  = await voyage.embed({
        input: batch.map(c => c.content), model: 'voyage-3', inputType: 'document',
      });

      const rows = batch.map((chunk, idx) => ({
        file_id:     fileId,
        content:     chunk.content,
        embedding:   embResp.data?.[idx]?.embedding,
        file_name:   finalFileName,
        file_type:   fileType,
        page_number: chunk.page_number,
        chunk_index: chunk.chunk_index,
        total_pages: pageCount,
        category:    finalCategory,
        metadata: {
          user_id: userId, file_name: finalFileName, file_id: fileId,
          file_type: fileType, page_number: chunk.page_number,
          chunk_index: chunk.chunk_index, total_pages: pageCount, category: finalCategory,
        },
      }));

      const { error: embErr } = await supabase.from('documents').insert(rows);
      if (embErr) console.error('Embed insert error:', embErr.message);
      embedded += rows.length;

      if (i + BATCH_SIZE < chunks.length) await new Promise(r => setTimeout(r, 2000));
    }

    console.log(`📦 Stored ${embedded} vectors → "${finalFileName}" [${finalCategory}]`);

    return NextResponse.json({
      success:       true,
      fileId,
      fileName:      finalFileName,
      category:      finalCategory,
      tags,
      chunksIndexed: embedded,
      wasRenamed:    finalFileName !== file.name,
      originalName:  file.name,
    });

  } catch (err: any) {
    console.error('❌ Upload Error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}


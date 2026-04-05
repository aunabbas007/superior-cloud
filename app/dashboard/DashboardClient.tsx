'use client';
import SplashScreen from '../../components/SplashScreen';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createBrowserClient } from '@supabase/ssr';
import { useRouter } from 'next/navigation';

// ── Supabase client (module-level singleton) ──────────────────────────────────
// CRITICAL: Must live outside the component. If created inside, React creates a
// new instance on every render — the new instance has no session, RLS blocks all
// queries, fetchFiles returns 0 rows, and the skeleton loader never clears.
// Module scope = created once, same instance reused, session persists correctly.



// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────
interface CloudFile {
  id:           string;
  name:         string;
  type:         string;
  size:         number;
  category:     string;
  tags:         string[];
  created_at:   string;
  storage_path: string;
  folder:       string;
  is_archived:  boolean;
}

interface Message {
  role:    'user' | 'assistant';
  content: string;
}

interface DupePair {
  fileA:      { id: string; name: string; category: string; size: number; created_at: string };
  fileB:      { id: string; name: string; category: string; size: number; created_at: string };
  similarity: number;
  reason:     'semantic' | 'filename' | 'both';
  label:      string;
}

interface FileOpDialogState {
  show:         boolean;
  operation:    string;
  fileIds:      string[];
  files:        { id: string; name: string; category: string }[];
  targetFolder?: string;
  summary:      string;
  explanation:  string;
  executing:    boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOAST NOTIFICATION SYSTEM (replaces all browser alert() calls)
// ─────────────────────────────────────────────────────────────────────────────
interface Toast { id: string; message: string; type: 'success' | 'error' | 'info' | 'warning'; }

// ─────────────────────────────────────────────────────────────────────────────
// MARKDOWN RENDERER
// Makes AI responses look like Claude/ChatGPT — bold, code blocks, lists, etc.
// Pure regex, no external library needed.
// ─────────────────────────────────────────────────────────────────────────────
function renderMarkdown(text: string): string {
  let s = text;
  // Code blocks  ``` ... ```
  s = s.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, c) =>
    `<pre class="md-pre"><code class="md-code">${c.replace(/</g,'&lt;').replace(/>/g,'&gt;').trim()}</code></pre>`);
  // Inline code
  s = s.replace(/`([^`\n]+)`/g, '<code class="md-inline">$1</code>');
  // Headers
  s = s.replace(/^### (.+)$/gm, '<h3 class="md-h3">$1</h3>');
  s = s.replace(/^## (.+)$/gm,  '<h2 class="md-h2">$1</h2>');
  s = s.replace(/^# (.+)$/gm,   '<h1 class="md-h1">$1</h1>');
  // Bold + italic
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong class="md-bold">$1</strong>');
  s = s.replace(/\*([^*\n]+?)\*/g, '<em class="md-em">$1</em>');
  // Source transparency (📍 🧠 ✅)
  s = s.replace(/^📍 (.+)$/gm, '<span class="md-source">📍 $1</span>');
  s = s.replace(/^🧠 (.+)$/gm, '<span class="md-reason">🧠 $1</span>');
  s = s.replace(/^✅ (.+)$/gm, '<span class="md-answer">✅ $1</span>');
  // Lists
  s = s.replace(/^[-•▸] (.+)$/gm, '<li class="md-li">$1</li>');
  s = s.replace(/^\d+\. (.+)$/gm, '<li class="md-oli">$1</li>');
  // Horizontal rule
  s = s.replace(/^---$/gm, '<hr class="md-hr"/>');
  // Line breaks and paragraphs
  s = s.replace(/\n\n/g, '<br/><br/>');
  s = s.replace(/\n/g, '<br/>');
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS & HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const MAX_STORAGE_BYTES = 1024 * 1024 * 1024; // 1 GB
const FOLDERS = ['My Cloud', 'Finance', 'Health', 'Work', 'Personal'] as const;
type FolderName = typeof FOLDERS[number] | 'Archive' | 'All Folders';

const CATEGORY_META: Record<string, { icon: string; color: string; bg: string; border: string }> = {
  // ── GROUP 1: DOCUMENTS & IDENTITY ─────────────────────────────────────────
  // Legal IDs, Financials, Academic/Professional, Handwriting
  'Government ID':          { icon: '🪪', color: 'text-amber-300',    bg: 'bg-amber-500/10',    border: 'border-amber-500/20'   },
  'Certificate':            { icon: '🏆', color: 'text-yellow-300',   bg: 'bg-yellow-500/10',   border: 'border-yellow-500/20'  },
  'Resume & CV':            { icon: '📄', color: 'text-blue-300',     bg: 'bg-blue-500/10',     border: 'border-blue-500/20'    },
  'Salary & Pay Slip':      { icon: '💰', color: 'text-emerald-300',  bg: 'bg-emerald-500/10',  border: 'border-emerald-500/20' },
  'Bank Statement':         { icon: '🏦', color: 'text-teal-300',     bg: 'bg-teal-500/10',     border: 'border-teal-500/20'    },
  'Tax Document':           { icon: '🧾', color: 'text-lime-300',     bg: 'bg-lime-500/10',     border: 'border-lime-500/20'    },
  'Receipt & Invoice':      { icon: '🧾', color: 'text-orange-300',   bg: 'bg-orange-500/10',   border: 'border-orange-500/20'  },
  'Medical Record':         { icon: '🏥', color: 'text-rose-300',     bg: 'bg-rose-500/10',     border: 'border-rose-500/20'    },
  'Legal Document':         { icon: '⚖️', color: 'text-red-300',      bg: 'bg-red-500/10',      border: 'border-red-500/20'     },
  'Business Report':        { icon: '💼', color: 'text-sky-300',      bg: 'bg-sky-500/10',      border: 'border-sky-500/20'     },
  'Research Paper':         { icon: '🔬', color: 'text-blue-400',     bg: 'bg-blue-400/10',     border: 'border-blue-400/20'    },
  'University Report':      { icon: '🎓', color: 'text-indigo-300',   bg: 'bg-indigo-500/10',   border: 'border-indigo-500/20'  },
  'Handwritten Note':       { icon: '✍️', color: 'text-fuchsia-300',  bg: 'bg-fuchsia-500/10',  border: 'border-fuchsia-500/20' },
  // ── GROUP 2: SCREENSHOTS & UTILITY ────────────────────────────────────────
  // Digital captures, technical schematics, QR codes, tickets
  'Technical Diagram':      { icon: '🤖', color: 'text-violet-300',   bg: 'bg-violet-500/10',   border: 'border-violet-500/20'  },
  'Code & Tech':            { icon: '⚙️', color: 'text-cyan-300',     bg: 'bg-cyan-500/10',     border: 'border-cyan-500/20'    },
  'Travel Ticket':          { icon: '🎫', color: 'text-purple-300',   bg: 'bg-purple-500/10',   border: 'border-purple-500/20'  },
  'QR Code & Barcode':      { icon: '📷', color: 'text-slate-300',    bg: 'bg-slate-500/10',    border: 'border-slate-500/20'   },
  'Chat & Conversation':    { icon: '💬', color: 'text-green-300',    bg: 'bg-green-500/10',    border: 'border-green-500/20'   },
  'Social Media':           { icon: '📱', color: 'text-pink-300',     bg: 'bg-pink-500/10',     border: 'border-pink-500/20'    },
  'Map & Navigation':       { icon: '🗺️', color: 'text-teal-300',     bg: 'bg-teal-500/10',     border: 'border-teal-500/20'    },
  'Study Notes':            { icon: '📚', color: 'text-indigo-300',   bg: 'bg-indigo-500/10',   border: 'border-indigo-500/20'  },
  'Data & Dashboard':       { icon: '📊', color: 'text-emerald-400',  bg: 'bg-emerald-500/10',  border: 'border-emerald-500/20' },
  // ── GROUP 3: PEOPLE ────────────────────────────────────────────────────────
  'Portrait & Selfie':      { icon: '🤳', color: 'text-pink-300',     bg: 'bg-pink-500/10',     border: 'border-pink-500/20'    },
  'Group & Family':         { icon: '👨‍👩‍👧‍👦', color: 'text-amber-300',   bg: 'bg-amber-500/10',    border: 'border-amber-500/20'   },
  // ── GROUP 4: EVENTS ────────────────────────────────────────────────────────
  'Personal Event':         { icon: '🎉', color: 'text-yellow-300',   bg: 'bg-yellow-500/10',   border: 'border-yellow-500/20'  },
  'Professional Event':     { icon: '🤝', color: 'text-blue-300',     bg: 'bg-blue-500/10',     border: 'border-blue-500/20'    },
  // ── GROUP 5: PLACES ────────────────────────────────────────────────────────
  'Architecture & Building':{ icon: '🏛️', color: 'text-stone-300',   bg: 'bg-stone-500/10',    border: 'border-stone-500/20'   },
  'Nature & Landscape':     { icon: '🌿', color: 'text-green-300',    bg: 'bg-green-500/10',    border: 'border-green-500/20'   },
  'Urban & Transit':        { icon: '🏙️', color: 'text-zinc-300',     bg: 'bg-zinc-500/10',     border: 'border-zinc-500/20'    },
  // ── GROUP 6: OBJECTS ───────────────────────────────────────────────────────
  'Vehicle':                { icon: '🚗', color: 'text-red-300',      bg: 'bg-red-500/10',      border: 'border-red-500/20'     },
  'Electronics & Gadget':   { icon: '💻', color: 'text-blue-300',     bg: 'bg-blue-500/10',     border: 'border-blue-500/20'    },
  'Animals & Wildlife':     { icon: '🐾', color: 'text-lime-300',     bg: 'bg-lime-500/10',     border: 'border-lime-500/20'    },
  'Food & Beverage':        { icon: '🍽️', color: 'text-orange-300',   bg: 'bg-orange-500/10',   border: 'border-orange-500/20'  },
  'Apparel & Fashion':      { icon: '👗', color: 'text-pink-400',     bg: 'bg-pink-500/10',     border: 'border-pink-500/20'    },
  // ── FALLBACK ───────────────────────────────────────────────────────────────
  'General':                { icon: '📁', color: 'text-gray-300',     bg: 'bg-gray-500/10',     border: 'border-gray-500/20'    },
};

function getCategoryMeta(category: string) {
  const key = Object.keys(CATEGORY_META).find(k =>
    category?.toLowerCase().includes(k.toLowerCase())
  );
  return CATEGORY_META[key || 'General'] || CATEGORY_META['General'];
}

function getFileIcon(type: string, name: string): string {
  if (type?.startsWith('image/'))                               return '🖼️';
  if (type?.includes('pdf'))                                    return '📕';
  if (type?.includes('word') || name?.endsWith('.docx'))        return '📘';
  return '📄';
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  if (bytes < 1024)          return `${bytes} B`;
  if (bytes < 1024 * 1024)   return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}


// ─────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE GRAPH COMPONENT
//
// Pure canvas — no D3, no external libraries, no cost.
// Force-directed layout using spring simulation (same algorithm as D3's
// forceSimulation, but written from scratch in ~80 lines).
//
// Each file = a node. Files in the same category are connected by edges.
// Node size = file size. Node color = category color.
// Physics: repulsion between all nodes, spring attraction on edges, damping.
// ─────────────────────────────────────────────────────────────────────────────
function KnowledgeGraph({ files, onSelectFile }: { files: CloudFile[]; onSelectFile: (id: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef  = useRef<{ nodes: any[]; edges: any[]; dragging: any; animFrame: number }>({
    nodes: [], edges: [], dragging: null, animFrame: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || files.length === 0) return;
    const ctx   = canvas.getContext('2d')!;
    const W     = canvas.offsetWidth;
    const H     = canvas.offsetHeight;
    canvas.width  = W * window.devicePixelRatio;
    canvas.height = H * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    // ── Build nodes ──────────────────────────────────────────────────────────
    const COLORS: Record<string, string> = {
      // Group 1 — Documents & Identity
      'Government ID':          '#f59e0b',
      'Certificate':            '#eab308',
      'Resume & CV':            '#3b82f6',
      'Salary & Pay Slip':      '#10b981',
      'Bank Statement':         '#14b8a6',
      'Tax Document':           '#84cc16',
      'Receipt & Invoice':      '#fb923c',
      'Medical Record':         '#f43f5e',
      'Legal Document':         '#ef4444',
      'Business Report':        '#0ea5e9',
      'Research Paper':         '#60a5fa',
      'University Report':      '#6366f1',
      'Handwritten Note':       '#d946ef',
      // Group 2 — Screenshots & Utility
      'Technical Diagram':      '#8b5cf6',
      'Code & Tech':            '#06b6d4',
      'Travel Ticket':          '#a855f7',
      'QR Code & Barcode':      '#94a3b8',
      'Chat & Conversation':    '#22c55e',
      'Social Media':           '#ec4899',
      'Map & Navigation':       '#2dd4bf',
      'Study Notes':            '#818cf8',
      'Data & Dashboard':       '#34d399',
      // Group 3 — People
      'Portrait & Selfie':      '#f472b6',
      'Group & Family':         '#fbbf24',
      // Group 4 — Events
      'Personal Event':         '#facc15',
      'Professional Event':     '#93c5fd',
      // Group 5 — Places
      'Architecture & Building':'#d6d3d1',
      'Nature & Landscape':     '#4ade80',
      'Urban & Transit':        '#a1a1aa',
      // Group 6 — Objects
      'Vehicle':                '#fca5a5',
      'Electronics & Gadget':   '#7dd3fc',
      'Animals & Wildlife':     '#bef264',
      'Food & Beverage':        '#fdba74',
      'Apparel & Fashion':      '#f9a8d4',
      // Fallback
      'General':                '#6b7280',
    };

    const nodes = files.map((f, i) => ({
      id:     f.id,
      name:   f.name.length > 18 ? f.name.slice(0, 16) + '…' : f.name,
      cat:    f.category,
      color:  COLORS[f.category] || '#6b7280',
      r:      Math.max(18, Math.min(36, 18 + Math.sqrt(f.size / 1024) * 0.4)),
      x:      W * 0.1 + Math.random() * W * 0.8,
      y:      H * 0.1 + Math.random() * H * 0.8,
      vx:     0, vy: 0,
    }));

    // ── Build edges (same category = connected) ───────────────────────────
    const edges: { a: number; b: number }[] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (nodes[i].cat === nodes[j].cat) edges.push({ a: i, b: j });
      }
    }

    stateRef.current.nodes = nodes;
    stateRef.current.edges = edges;

    // ── Physics simulation ────────────────────────────────────────────────
    const REPULSE = 3200;
    const SPRING  = 0.012;
    const REST    = 120;
    const DAMP    = 0.82;
    const CENTER  = 0.003;

    function tick() {
      const ns = stateRef.current.nodes;

      // Repulsion between all pairs
      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          const dx  = ns[j].x - ns[i].x;
          const dy  = ns[j].y - ns[i].y;
          const d2  = Math.max(1, dx * dx + dy * dy);
          const f   = REPULSE / d2;
          const nx_ = dx / Math.sqrt(d2);
          const ny_ = dy / Math.sqrt(d2);
          ns[i].vx -= f * nx_; ns[i].vy -= f * ny_;
          ns[j].vx += f * nx_; ns[j].vy += f * ny_;
        }
      }

      // Spring attraction on edges
      for (const e of stateRef.current.edges) {
        const a  = ns[e.a]; const b = ns[e.b];
        const dx = b.x - a.x; const dy = b.y - a.y;
        const d  = Math.sqrt(dx * dx + dy * dy) || 1;
        const f  = (d - REST) * SPRING;
        a.vx += f * dx / d; a.vy += f * dy / d;
        b.vx -= f * dx / d; b.vy -= f * dy / d;
      }

      // Centre gravity + integrate
      for (const n of ns) {
        if (stateRef.current.dragging?.id === n.id) continue;
        n.vx += (W / 2 - n.x) * CENTER;
        n.vy += (H / 2 - n.y) * CENTER;
        n.vx *= DAMP; n.vy *= DAMP;
        n.x  += n.vx; n.y  += n.vy;
        n.x   = Math.max(n.r, Math.min(W - n.r, n.x));
        n.y   = Math.max(n.r, Math.min(H - n.r, n.y));
      }

      draw();
      stateRef.current.animFrame = requestAnimationFrame(tick);
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);

      // Edges
      ctx.lineWidth = 1;
      for (const e of stateRef.current.edges) {
        const a = stateRef.current.nodes[e.a];
        const b = stateRef.current.nodes[e.b];
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = a.color + '30';
        ctx.stroke();
      }

      // Nodes
      for (const n of stateRef.current.nodes) {
        // Glow
        const grd = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r * 2.2);
        grd.addColorStop(0, n.color + '20');
        grd.addColorStop(1, 'transparent');
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * 2.2, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();

        // Circle
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = n.color + '25';
        ctx.fill();
        ctx.strokeStyle = n.color + 'BB';
        ctx.lineWidth   = 1.5;
        ctx.stroke();

        // Label
        ctx.fillStyle  = '#e2e8f0';
        ctx.font       = `500 9px "DM Sans", sans-serif`;
        ctx.textAlign  = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(n.name, n.x, n.y);
      }
    }

    stateRef.current.animFrame = requestAnimationFrame(tick);

    // ── Mouse interaction ─────────────────────────────────────────────────
    function getNode(mx: number, my: number) {
      return stateRef.current.nodes.find(n => Math.hypot(n.x - mx, n.y - my) < n.r + 4) ?? null;
    }
    const onDown = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx   = e.clientX - rect.left;
      const my   = e.clientY - rect.top;
      const hit  = getNode(mx, my);
      if (hit) { stateRef.current.dragging = hit; hit.vx = 0; hit.vy = 0; }
    };
    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const d    = stateRef.current.dragging;
      if (d) { d.x = e.clientX - rect.left; d.y = e.clientY - rect.top; }
      const hit  = getNode(e.clientX - rect.left, e.clientY - rect.top);
      canvas.style.cursor = hit ? 'pointer' : 'default';
    };
    const onUp = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const d    = stateRef.current.dragging;
      if (d) {
        const dist = Math.hypot(d.x - (e.clientX - rect.left), d.y - (e.clientY - rect.top));
        if (dist < 4) onSelectFile(d.id);
      }
      stateRef.current.dragging = null;
    };
    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseup',   onUp);

    return () => {
      cancelAnimationFrame(stateRef.current.animFrame);
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseup',   onUp);
    };
  }, [files]);

  if (files.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
        Upload files to see your knowledge graph
      </div>
    );
  }

  return <canvas ref={canvasRef} style={{ width: '100%', flex: 1 }} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────
export default function Dashboard() {
  // Supabase client created inside component — never runs at build time
  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  const router   = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef   = useRef<HTMLDivElement>(null);
  const tokenRef     = useRef<string>('');   // always holds the latest JWT — never stale

  // ── State ────────────────────────────────────────────────────────────────
  const [userId,         setUserId]         = useState('');
  const [userEmail,      setUserEmail]      = useState('');
  const [files,          setFiles]          = useState<CloudFile[]>([]);
  const [selectedFiles,  setSelectedFiles]  = useState<string[]>([]);
  const [activeCategory, setActiveCategory] = useState('All');
  const [searchQuery,    setSearchQuery]    = useState('');
  const [liveMatches,    setLiveMatches]    = useState<CloudFile[]>([]);
  const [showDropdown,   setShowDropdown]   = useState(false);
  const [isUploading,    setIsUploading]    = useState(false);
  const [uploadStatus,   setUploadStatus]   = useState('');
  const [uploadPct,      setUploadPct]      = useState(0);
  const [chatOpen,       setChatOpen]       = useState(false);
  const [chatMessage,    setChatMessage]    = useState('');
  const [chatHistory,    setChatHistory]    = useState<Message[]>([]);
  const [isChatting,     setIsChatting]     = useState(false);
  const [deletingId,     setDeletingId]     = useState<string | null>(null);
  const [viewMode,       setViewMode]       = useState<'grid' | 'list'>('grid');
  const [duplicateAlert, setDuplicateAlert] = useState<{ show: boolean; existingName: string }>({ show: false, existingName: '' });
  const [renameAlert,    setRenameAlert]    = useState<{ show: boolean; original: string; savedAs: string }>({ show: false, original: '', savedAs: '' });
  // ── NEW FEATURE STATE ────────────────────────────────────────────────────
  const [isListening,    setIsListening]    = useState(false);           // voice input
  const [graphOpen,      setGraphOpen]      = useState(false);           // knowledge graph modal
  const [alertsOpen,     setAlertsOpen]     = useState(false);           // alerts panel
  const [alerts,         setAlerts]         = useState<any[]>([]);       // proactive alerts
  const [unreadCount,    setUnreadCount]    = useState(0);               // bell badge
  const [memoryFacts,    setMemoryFacts]    = useState(0);               // memory indicator
  const [synthMessage,   setSynthMessage]   = useState('');              // last synthesis output
  const [isLoadingFiles, setIsLoadingFiles] = useState(true);               // skeleton loader
  const [sessionToken,   setSessionToken]   = useState('');               // JWT mirror of tokenRef (for reactive reads)
  const [toasts,         setToasts]         = useState<Toast[]>([]);      // toast notifications
  const [isDragOver,     setIsDragOver]     = useState(false);            // drag & drop state
  const [streamingMsg,   setStreamingMsg]   = useState('');               // live streaming text
  const [previewFile,    setPreviewFile]    = useState<CloudFile|null>(null); // file preview panel
  const recognitionRef = useRef<any>(null);
  // ── New feature state ────────────────────────────────────────────────────
  const [fileOpsDialog,  setFileOpsDialog]  = useState<FileOpDialogState | null>(null);
  const [dupePanel,      setDupePanel]      = useState<{ show: boolean; scanning: boolean; results: DupePair[] }>({ show: false, scanning: false, results: [] });
  const [previewContent, setPreviewContent] = useState<string>('');
  const [previewTab,     setPreviewTab]     = useState<'info'|'pdf'>('info');
  const [previewSignedUrl, setPreviewSignedUrl] = useState<string|null>(null);
  const [previewUrlLoading, setPreviewUrlLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [activeFolder,   setActiveFolder]   = useState<FolderName>('All Folders');
  // ── Feature states ───────────────────────────────────────────────────────
  const [cloudStatus,    setCloudStatus]    = useState<'ok'|'waking'|'checking'>('checking');
  const [wakeCountdown,  setWakeCountdown]  = useState(30);
  const [timelineOpen,   setTimelineOpen]   = useState(false);
  const [timelineData,   setTimelineData]   = useState<any>(null);
  const [timelineLoading,setTimelineLoading]= useState(false);
  const [sensitivityOpen,setSensitivityOpen]= useState(false);
  const [sensitivityData,setSensitivityData]= useState<any>(null);
  const [sensitivityLoading,setSensitivityLoading] = useState(false);
  const [reclassifyFile, setReclassifyFile] = useState<string|null>(null); // fileId being reclassified
  const [downloadingId,  setDownloadingId]  = useState<string|null>(null);
  const [sidebarOpen,    setSidebarOpen]    = useState(false);  // mobile sidebar toggle
  // Splash: show once per browser session, not on every navigation
  const [showSplash,     setShowSplash]     = useState(() => {
    if (typeof window === 'undefined') return false;
    const seen = sessionStorage.getItem('splash_seen');
    if (!seen) { sessionStorage.setItem('splash_seen', '1'); return true; }
    return false;
  });
  const [deleteConfirm,  setDeleteConfirm]  = useState<{ fileId: string; fileName: string } | null>(null);

  // ── Auth initialisation ───────────────────────────────────────────────────
  //
  //  The primary auth guard is middleware.ts (runs server-side before any HTML
  //  is sent). This client-side effect only needs to do two things:
  //
  //  1. On mount — read the session that middleware already validated and
  //     populate userId / tokenRef so data fetching can begin.
  //     Uses getSession() which reads the cookie synchronously — no race,
  //     because middleware already confirmed the cookie is valid before this
  //     component even rendered. If it's somehow absent, redirect to login.
  //
  //  2. Subscribe to onAuthStateChange — handles SIGNED_OUT (logout button,
  //     token expiry) and TOKEN_REFRESHED (silent JWT rotation every ~55 min).
  //
  //  What's gone and why:
  //    ✗ The 200ms setTimeout re-check — this was the exact source of the
  //      "flash then kick" bug. getSession() returned null mid-flight, the
  //      timer fired, and the user was sent back to /login even though the
  //      session was perfectly valid. Removed entirely.
  //    ✗ The complex condition (!session && event !== 'INITIAL_SESSION') —
  //      replaced with a simple SIGNED_OUT check. INITIAL_SESSION with a null
  //      session can never reach here because middleware blocks unauthenticated
  //      requests before the page renders.
  //
  useEffect(() => {
    // Step 1: read the validated session immediately on mount.
    // Middleware has already confirmed there IS a valid session before serving
    // this page, so getSession() will always find it. This is synchronous
    // (reads from the cookie that middleware just validated) — no race.
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        // Should not happen (middleware blocks this), but belt-and-suspenders.
        router.push('/login');
        return;
      }
      tokenRef.current = session.access_token;
      setSessionToken(session.access_token);
      setUserId(session.user.id);
      setUserEmail(session.user.email ?? '');
    });

    // Step 2: watch for session changes AFTER the initial load.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        // User signed out (logout button or Supabase invalidated the session).
        router.push('/login');
        return;
      }
      if (session) {
        // TOKEN_REFRESHED, SIGNED_IN, USER_UPDATED — keep tokenRef current.
        tokenRef.current = session.access_token;
        setSessionToken(session.access_token);
        setUserId(session.user.id);
        setUserEmail(session.user.email ?? '');
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // ── Supabase keepalive check ───────────────────────────────────────────
  useEffect(() => {
    let countdown = 30;
    const check = async () => {
      try {
        const res = await fetch('/api/health', { signal: AbortSignal.timeout(8000) });
        if (res.ok) { setCloudStatus('ok'); }
        else { throw new Error('not ok'); }
      } catch {
        setCloudStatus('waking');
        const timer = setInterval(() => {
          countdown -= 1;
          setWakeCountdown(countdown);
          if (countdown <= 0) {
            clearInterval(timer);
            countdown = 30;
            setWakeCountdown(30);
            check(); // retry
          }
        }, 1000);
      }
    };
    check();
  }, []);

  // ── Load persisted chat history on mount ──────────────────────────────
  useEffect(() => {
    if (!userId) return;
    fetch('/api/conversations', { headers: { 'Authorization': `Bearer ${tokenRef.current}` } })
      .then(r => r.json())
      .then(d => {
        if (d.messages?.length > 0) {
          setChatHistory(d.messages.map((m: any) => ({
            role: m.role, content: m.content, isSynthesis: m.isSynthesis
          })));
        }
      })
      .catch(() => {});
  }, [userId]);

  useEffect(() => {
    if (userId) {
      setIsLoadingFiles(true);   // reset skeleton on every userId change (e.g. re-login)
      fetchFiles(userId);        // pass uid directly — avoids stale closure bug
    }
  }, [userId]);

  // ── Fetch files ──────────────────────────────────────────────────────────
  const fetchFiles = async (uid?: string) => {
    const id = uid || userId;
    if (!id) return;
    const { data, error } = await supabase
      .from('files')
      .select('id, name, type, size, category, tags, created_at, storage_path, folder, is_archived')
      .eq('user_id', id)
      .order('created_at', { ascending: false });
    if (!error) setFiles(data || []);
    else console.error('fetchFiles error:', error.message);
    setIsLoadingFiles(false);   // ← THE FIX: always clear skeleton after fetch
  };

  // ── Storage stats ────────────────────────────────────────────────────────
  const totalUsed  = files.reduce((s, f) => s + (f.size || 0), 0);
  const storagePct = ((totalUsed / MAX_STORAGE_BYTES) * 100).toFixed(1);

  // ── Category map ─────────────────────────────────────────────────────────
  const categoryMap = files.reduce<Record<string, number>>((acc, f) => {
    const cat = f.category || 'General';
    acc[cat] = (acc[cat] || 0) + 1;
    return acc;
  }, {});
  const categories = Object.entries(categoryMap).sort((a, b) => b[1] - a[1]);

  // ── Filtered display ─────────────────────────────────────────────────────
  const displayedFiles = files.filter(f => {
    // Archived files only visible in Archive folder
    if (f.is_archived  && activeFolder !== 'Archive')    return false;
    if (!f.is_archived && activeFolder === 'Archive')    return false;
    // Folder filter (skip when 'All Folders')
    if (activeFolder !== 'All Folders' && activeFolder !== 'Archive' && f.folder !== activeFolder) return false;
    const matchesCat    = activeCategory === 'All' || f.category === activeCategory;
    const q             = searchQuery.toLowerCase();
    const matchesSearch = !q ||
      f.name.toLowerCase().includes(q) ||
      f.category?.toLowerCase().includes(q) ||
      f.tags?.some(t => t.toLowerCase().includes(q));
    return matchesCat && matchesSearch;
  });

  // ── Live search dropdown ─────────────────────────────────────────────────
  useEffect(() => {
    if (!searchQuery.trim()) { setLiveMatches([]); setShowDropdown(false); return; }
    const q       = searchQuery.toLowerCase();
    const matches = files.filter(f =>
      f.name.toLowerCase().includes(q) ||
      f.category?.toLowerCase().includes(q) ||
      f.tags?.some(t => t.toLowerCase().includes(q))
    ).slice(0, 6);
    setLiveMatches(matches);
    setShowDropdown(matches.length > 0);
  }, [searchQuery, files]);

  // ── Load alerts & memory on userId ready ─────────────────────────────────
  useEffect(() => {
    if (!userId) return;
    // Fetch existing alerts
    fetch('/api/alerts', { headers: { 'Authorization': `Bearer ${tokenRef.current}` } }).then(r => r.json()).then(d => { setAlerts(d.alerts || []); setUnreadCount(d.unreadCount || 0); }).catch(() => {});
    // Load memory fact count
    fetch('/api/memory', { headers: { 'Authorization': `Bearer ${tokenRef.current}` } }).then(r => r.json()).then(d => setMemoryFacts(d.factCount || 0)).catch(() => {});
    // Scan for new alerts (background, fire and forget)
    fetch('/api/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenRef.current}` }, body: JSON.stringify({}) }).then(r => r.json()).then(d => { if ((d.generated || 0) > 0) { fetch('/api/alerts', { headers: { 'Authorization': `Bearer ${tokenRef.current}` } }).then(r2 => r2.json()).then(d2 => { setAlerts(d2.alerts || []); setUnreadCount(d2.unreadCount || 0); }).catch(() => {}); } }).catch(() => {});
  }, [userId]);

  // ── Auto-scroll chat ──────────────────────────────────────────────────────
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, isChatting]);

  // ── Auth header helper ────────────────────────────────────────────────────
  // Uses tokenRef (not state) because:
  //   State has a render-cycle delay — tokenRef is set synchronously.
  //   onAuthStateChange keeps tokenRef fresh whenever Supabase refreshes the JWT.
  //   This eliminates the "Missing Authorization header" race condition entirely.
  const authHeaders = (): Record<string, string> => {
    const token = tokenRef.current;
    if (!token) {
      // Token genuinely missing — session expired or user not logged in
      router.push('/login');
      return {};
    }
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    };
  };

  // ── Toast notifications (replaces all alert() calls) ──────────────────────
  const showToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  // Ctrl/Cmd+K → focus search, Ctrl/Cmd+Enter → send chat, Escape → close panels
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === 'k') { e.preventDefault(); (document.querySelector('input[placeholder*="Search"]') as HTMLInputElement)?.focus(); }
      if (meta && e.key === 'Enter') { e.preventDefault(); handleChat(); }
      if (e.key === 'Escape') { setGraphOpen(false); setAlertsOpen(false); setPreviewFile(null); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [chatMessage]);

  // ── Voice Input (Web Speech API — free, no external API needed) ─────────────
  const startVoice = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { alert('Voice input is not supported in this browser. Try Chrome or Edge.'); return; }
    if (isListening) { recognitionRef.current?.stop(); return; }
    const recognition = new SR();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult  = (e: any) => { setChatMessage(e.results[0][0].transcript); setIsListening(false); };
    recognition.onerror   = ()      => setIsListening(false);
    recognition.onend     = ()      => setIsListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [isListening]);

  // ── Core upload logic (used by both button and drag & drop) ─────────────
  // KEY FIX: userId is appended to FormData so the API gets the real user ID.
  // Previously the API used broken cookie auth → got null user → saved files
  // with dummy UUID "00000000..." → dashboard fetched with real userId → 0 results.
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !userId) return;

    setIsUploading(true);
    setUploadPct(10);
    setUploadStatus('Reading file...');

    const formData = new FormData();
    formData.append('file', file);
    // userId is no longer sent in body — auth is verified via JWT Bearer token

    // Track timeouts so we can cancel them on early exit (e.g. dedup)
    const timers: ReturnType<typeof setTimeout>[] = [];

    try {
      const stages = [
        { pct: 25, msg: 'Extracting content...',     delay: 1500 },
        { pct: 50, msg: 'AI tagging & analyzing...', delay: 3500 },
        { pct: 75, msg: 'Building embeddings...',    delay: 6000 },
        { pct: 90, msg: 'Indexing knowledge...',     delay: 9000 },
      ];
      stages.forEach(({ pct, msg, delay }) => {
        timers.push(setTimeout(() => { setUploadPct(pct); setUploadStatus(msg); }, delay));
      });

      const response = await fetch('/api/files/upload', {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${tokenRef.current}` },
        // NOTE: Do NOT set Content-Type here — browser sets it automatically
        // with the correct multipart/form-data boundary when body is FormData
        body: formData,
      });
      const result   = await response.json();

      // Cancel fake progress timers — we have a real result now
      timers.forEach(clearTimeout);
      setUploadPct(100);

      if (!response.ok) {
        setUploadStatus(`❌ ${result.error ?? 'Upload failed.'}`);
        setTimeout(() => { setIsUploading(false); setUploadStatus(''); setUploadPct(0); }, 4000);
        return;
      }

      // ── CASE 1: Duplicate content detected ─────────────────────────────────
      // Same bytes already in cloud — no point re-indexing.
      // Show the user a clear, friendly message immediately.
      if (result.isDuplicate) {
        setUploadPct(100);
        setUploadStatus(`✦ Already in your cloud!`);
        // Show a toast-style banner with the original filename
        setDuplicateAlert({
          show:         true,
          existingName: result.existingName ?? file.name,
        });
        setTimeout(() => {
          setIsUploading(false);
          setUploadStatus('');
          setUploadPct(0);
          setDuplicateAlert({ show: false, existingName: '' });
        }, 4000);
        return;
      }

      // ── CASE 2: Successful upload, file was renamed (name conflict) ─────────
      // Different content, same original filename as an existing file.
      // We auto-renamed it — let the user know.
      if (result.renamedFrom) {
        setUploadStatus(`✓ Saved as "${result.fileName}"`);
        setRenameAlert({
          show:       true,
          original:   result.renamedFrom,
          savedAs:    result.fileName,
        });
        await fetchFiles();
        setTimeout(() => {
          setIsUploading(false);
          setUploadStatus('');
          setUploadPct(0);
          setRenameAlert({ show: false, original: '', savedAs: '' });
        }, 5000);
        return;
      }

      // ── CASE 3: Normal successful upload ────────────────────────────────────
      setUploadStatus(`✓ "${result.fileName}" added to your cloud!`);
      await fetchFiles();
      setTimeout(() => { setIsUploading(false); setUploadStatus(''); setUploadPct(0); }, 2500);

    } catch {
      timers.forEach(clearTimeout);
      setUploadStatus('Upload failed. Check your connection.');
      setTimeout(() => { setIsUploading(false); setUploadPct(0); }, 3000);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // ── Delete ────────────────────────────────────────────────────────────────
  // ── Step 1: show custom dialog (replaces ugly browser confirm())
  const handleDelete = (fileId: string, fileName: string) => {
    setDeleteConfirm({ fileId, fileName });
  };

  // ── Step 2: execute after user confirms in the dialog
  const executeDelete = async () => {
    if (!deleteConfirm) return;
    const { fileId, fileName } = deleteConfirm;
    setDeleteConfirm(null); // close dialog immediately
    const snapshot = files.find(f => f.id === fileId);
    setFiles(prev => prev.filter(f => f.id !== fileId)); // optimistic remove
    setSelectedFiles(prev => prev.filter(id => id !== fileId));
    if (previewFile?.id === fileId) { setPreviewFile(null); setPreviewContent(''); setPreviewTab('info'); setPreviewSignedUrl(null); }
    setDeletingId(fileId);
    try {
      const res  = await fetch('/api/files/delete', {
        method:  'DELETE',
        headers: authHeaders(),
        body:    JSON.stringify({ fileId }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(`"${fileName}" deleted`, 'success');
      } else {
        if (snapshot) setFiles(prev => [snapshot, ...prev]);
        showToast(`Delete failed: ${data.error ?? 'Unknown error'}`, 'error');
      }
    } catch (err: any) {
      if (snapshot) setFiles(prev => [snapshot, ...prev]);
      showToast(`Delete failed: ${err.message}`, 'error');
    } finally {
      setDeletingId(null);
    }
  };

  // ── Chat (STREAMING) ──────────────────────────────────────────────────────
  // Reads the SSE stream from /api/chat and updates state token-by-token.
  // User sees words appearing immediately — no waiting for full response.
  const handleChat = async () => {
    if (!chatMessage.trim() || isChatting) return;

    setChatHistory(prev => [...prev, { role: 'user', content: chatMessage }]);
    const currentMsg = chatMessage;
    setChatMessage('');
    setIsChatting(true);
    setStreamingMsg('');

    let isSynthesisMsg = false;

    try {
      const res = await fetch('/api/chat', {
        method:  'POST',
        headers: authHeaders(),
        body:    JSON.stringify({
          message:    currentMsg,
          fileFilter: selectedFiles,
          history:    chatHistory.map(m => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Server error');
      }

      // ── FILE OP PREVIEW: server returns JSON, not SSE ─────────────────────
      // When the AI detects a natural language file operation command, it
      // returns application/json with type='file_op_preview' instead of
      // streaming. We show a confirmation dialog for the user to review.
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const data = await res.json();
        if (data.type === 'file_op_preview') {
          setIsChatting(false);
          // Show the summary as an assistant message
          const assistantMsg = `**I can do that.** Here's what I'll do:

${data.summary}

*${data.explanation}*

*${data.files.length} file${data.files.length > 1 ? 's' : ''} will be affected. Review and confirm below.*`;
          setChatHistory(prev => [...prev, { role: 'assistant', content: assistantMsg }]);
          setFileOpsDialog({
            show: true, executing: false,
            operation:      data.operation,
            fileIds:        data.fileIds,
            files:          data.files,
            targetFolder:   data.targetFolder,
            targetCategory: data.targetCategory,
            summary:        data.summary,
            explanation:    data.explanation,
          } as any);
          return;
        }
        // Unknown JSON response — treat as error
        throw new Error(data.error ?? 'Unexpected server response');
      }

      // Read the SSE stream
      const reader  = res.body!.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';
      let   full    = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.type === 'meta') {
              isSynthesisMsg = parsed.isSynthesis;
            } else if (parsed.type === 'token') {
              full += parsed.token;
              setStreamingMsg(full);
            } else if (parsed.type === 'error') {
              throw new Error(parsed.message);
            } else if (parsed.type === 'done') {
              // Stream complete — move from streaming state to chat history
              setStreamingMsg('');
              if (isSynthesisMsg) setSynthMessage(full);
              setChatHistory(prev => [...prev, {
                role: 'assistant', content: full, isSynthesis: isSynthesisMsg
              } as any]);
              // Persist this message pair to DB (fire-and-forget)
              saveChatMessages(currentMsg, full, isSynthesisMsg);
              // Refresh memory count so the UI shows the latest number
              fetch('/api/memory', { headers: authHeaders() })
                .then(r => r.json())
                .then(d => { if (d.factCount !== undefined) setMemoryFacts(d.factCount); })
                .catch(() => {});
            }
          } catch {}
        }
      }
    } catch (err: any) {
      setStreamingMsg('');
      setChatHistory(prev => [...prev, {
        role: 'assistant',
        content: `⚠️ ${err.message || 'Something went wrong. Please try again.'}`
      }]);
    } finally {
      setIsChatting(false);
    }
  };

  const toggleFileSelect = (id: string) =>
    setSelectedFiles(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const openPreview = (file: CloudFile) => {
    setPreviewFile(file);
    setPreviewSignedUrl(null);
    loadPreviewContent(file);
    // Auto-fetch signed URL for inline viewer — fires immediately on open
    // PDF and images render natively in browser
    // DOCX cannot be rendered natively — shows extracted text only
    if (file.type === 'application/pdf' || file.type?.startsWith('image/')) {
      fetchPreviewUrl(file.id);
    }
  };

  // ── Drag & Drop handlers ───────────────────────────────────────────────────
  const handleDragOver  = (e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true); };
  const handleDragLeave = (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false); };
  const handleDrop      = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const allowed = ['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/png','image/jpeg','image/jpg'];
    if (!allowed.includes(file.type)) { showToast('Unsupported file type. Use PDF, DOCX, PNG, or JPG.', 'error'); return; }
    // Trigger the upload using same flow as the file input
    const dt = new DataTransfer(); dt.items.add(file);
    if (fileInputRef.current) { fileInputRef.current.files = dt.files; fileInputRef.current.dispatchEvent(new Event('change', { bubbles: true })); }
  };

  // ── Execute confirmed file operation ────────────────────────────────────
  const handleExecuteFileOps = async () => {
    if (!fileOpsDialog) return;
    setFileOpsDialog(prev => prev ? { ...prev, executing: true } : null);
    try {
      // Reclassify is handled by a different endpoint than other file ops
      if (fileOpsDialog.operation === 'reclassify') {
        const targetCat = (fileOpsDialog as any).targetCategory;
        if (!targetCat) {
          showToast('No target category specified', 'error');
          setFileOpsDialog(prev => prev ? { ...prev, executing: false } : null);
          return;
        }
        // Reclassify each file
        const results = await Promise.all(
          fileOpsDialog.fileIds.map(fileId =>
            fetch('/api/files/reclassify', {
              method: 'PATCH',
              headers: authHeaders(),
              body: JSON.stringify({ fileId, newCategory: targetCat }),
            }).then(r => r.json())
          )
        );
        const allOk = results.every(r => r.success);
        if (allOk) {
          // Update local state immediately — no fetchFiles needed
          setFiles(prev => prev.map(f =>
            fileOpsDialog.fileIds.includes(f.id) ? { ...f, category: targetCat } : f
          ));
          showToast(`Reclassified ${fileOpsDialog.fileIds.length} file(s) → "${targetCat}"`, 'success');
          setFileOpsDialog(null);
        } else {
          showToast('Reclassify partially failed', 'error');
          setFileOpsDialog(prev => prev ? { ...prev, executing: false } : null);
        }
        return;
      }

      // All other operations (move, archive, delete, restore, rename)
      const res  = await fetch('/api/files/ops', {
        method:  'POST',
        headers: authHeaders(),
        body:    JSON.stringify({
          operation:    fileOpsDialog.operation,
          fileIds:      fileOpsDialog.fileIds,
          targetFolder: fileOpsDialog.targetFolder,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(data.message, 'success');
        await fetchFiles();
        setFileOpsDialog(null);
      } else {
        showToast(data.error ?? 'Operation failed', 'error');
        setFileOpsDialog(prev => prev ? { ...prev, executing: false } : null);
      }
    } catch (err: any) {
      showToast(err.message, 'error');
      setFileOpsDialog(prev => prev ? { ...prev, executing: false } : null);
    }
  };

  // ── Scan for semantic duplicates ─────────────────────────────────────────
  const handleSemanticDupeScan = async () => {
    setDupePanel({ show: true, scanning: true, results: [] });
    try {
      const res  = await fetch('/api/files/semantic-dupes', {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok) {
        setDupePanel({ show: true, scanning: false, results: data.pairs ?? [] });
        if ((data.pairs ?? []).length === 0) showToast(data.message, 'info');
      } else {
        showToast(data.error ?? 'Scan failed', 'error');
        setDupePanel({ show: false, scanning: false, results: [] });
      }
    } catch (err: any) {
      showToast(err.message, 'error');
      setDupePanel({ show: false, scanning: false, results: [] });
    }
  };

  // ── Download synthesis as PDF (browser print dialog) ─────────────────────
  const handleDownloadPDF = (markdown: string) => {
    const html = markdown
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm,  '<h1>$1</h1>')
      .replace(/^### (.+)$/gm,'<h3>$1</h3>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g,    '<em>$1</em>')
      .replace(/^[-•] (.+)$/gm, '<li>$1</li>')
      .replace(/^---$/gm,       '<hr/>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g,   '<br/>');

    const win = window.open('', '_blank');
    if (!win) { showToast('Allow popups to download PDF', 'warning'); return; }
    win.document.write(`<!DOCTYPE html><html><head><title>A≡B — Report</title>
<style>
  body{font-family:Georgia,serif;max-width:800px;margin:40px auto;padding:0 40px;color:#1a1a2e;line-height:1.8;font-size:15px}
  h1{font-size:2em;border-bottom:2px solid #2563eb;padding-bottom:8px;color:#1e3a5f}
  h2{font-size:1.4em;color:#1e3a5f;margin-top:2em}
  h3{font-size:1.15em;color:#334155}
  strong{color:#1e3a5f}
  hr{border:none;border-top:1px solid #cbd5e1;margin:2em 0}
  li{margin:4px 0}
  p{margin:0.8em 0}
  @media print{body{margin:0;padding:20px}}
</style></head><body><p>${html}</p>
<script>window.onload=()=>{window.print();setTimeout(()=>window.close(),1000)}</script>
</body></html>`);
    win.document.close();
  };

  // ── Load preview content from documents table ─────────────────────────────
  const loadPreviewContent = async (file: CloudFile) => {
    setPreviewContent('');
    setPreviewLoading(true);
    try {
      const { data: chunks } = await supabase
        .from('documents')
        .select('content, chunk_index')
        .eq('file_id', file.id)
        .order('chunk_index', { ascending: true })
        .limit(5);
      if (chunks && chunks.length > 0) {
        const raw = chunks.map((c: any) => c.content).join('\n\n');
        setPreviewContent(raw.slice(0, 3000) + (raw.length > 3000 ? '\n\n[…preview truncated — full content is indexed for AI search]' : ''));
      } else {
        setPreviewContent('No extracted content available for this file.');
      }
    } catch {
      setPreviewContent('Could not load preview.');
    } finally {
      setPreviewLoading(false);
    }
  };

  // ── Download original file ────────────────────────────────────────────────
  // Fetch signed URL for INLINE preview (no Content-Disposition: attachment)
  // Uses /api/files/preview — NOT /api/files/download — so browser renders
  // the PDF inline in the iframe instead of triggering a download.
  const fetchPreviewUrl = async (fileId: string) => {
    setPreviewUrlLoading(true);
    try {
      const res  = await fetch(`/api/files/preview?fileId=${fileId}`, { headers: authHeaders() });
      const data = await res.json();
      if (res.ok && data.url) setPreviewSignedUrl(data.url);
      else setPreviewSignedUrl(null);
    } catch { setPreviewSignedUrl(null); }
    finally  { setPreviewUrlLoading(false); }
  };

  const handleDownloadFile = async (file: CloudFile) => {
    setDownloadingId(file.id);
    try {
      const res  = await fetch(`/api/files/download?fileId=${file.id}`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Download failed', 'error'); return; }
      // Open signed URL in new tab — browser handles download
      window.open(data.url, '_blank');
    } catch (err: any) {
      showToast('Download failed: ' + err.message, 'error');
    } finally {
      setDownloadingId(null);
    }
  };

  // ── Reclassify file ────────────────────────────────────────────────────────
  const handleReclassify = async (fileId: string, newCategory: string) => {
    try {
      const res  = await fetch('/api/files/reclassify', {
        method: 'PATCH', headers: authHeaders(),
        body: JSON.stringify({ fileId, newCategory }),
      });
      const data = await res.json();
      if (res.ok) {
        setFiles(prev => prev.map(f => f.id === fileId ? { ...f, category: newCategory } : f));
        showToast(`Reclassified → "${newCategory}"`, 'success');
      } else {
        showToast(data.error || 'Reclassify failed', 'error');
      }
    } catch (err: any) {
      showToast('Reclassify failed: ' + err.message, 'error');
    } finally {
      setReclassifyFile(null);
    }
  };

  // ── Personal Timeline ─────────────────────────────────────────────────────
  const handleOpenTimeline = async () => {
    setTimelineOpen(true);
    if (timelineData) return; // use cached
    setTimelineLoading(true);
    try {
      const res  = await fetch('/api/timeline', { headers: authHeaders() });
      const data = await res.json();
      if (res.ok) setTimelineData(data);
      else showToast(data.error || 'Timeline failed', 'error');
    } catch (err: any) {
      showToast('Timeline error: ' + err.message, 'error');
    } finally {
      setTimelineLoading(false);
    }
  };

  // ── Privacy Sensitivity Scanner ───────────────────────────────────────────
  const handleSensitivityScan = async () => {
    setSensitivityOpen(true);
    setSensitivityLoading(true);
    try {
      const res  = await fetch('/api/sensitivity', { method: 'POST', headers: authHeaders(), body: '{}' });
      const data = await res.json();
      if (res.ok) setSensitivityData(data);
      else showToast(data.error || 'Scan failed', 'error');
    } catch (err: any) {
      showToast('Scan error: ' + err.message, 'error');
    } finally {
      setSensitivityLoading(false);
    }
  };

  // ── Save chat to DB after stream ────────────────────────────────────────────
  // Called from handleChat after stream completes
  const saveChatMessages = async (userMsg: string, assistantMsg: string, isSynthesis: boolean) => {
    if (!userId || !userMsg || !assistantMsg) return;
    fetch('/api/conversations', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ messages: [
        { role: 'user',      content: userMsg,       isSynthesis: false },
        { role: 'assistant', content: assistantMsg,  isSynthesis },
      ]}),
    }).catch(() => {});
  };

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <>
    {showSplash && (
      <SplashScreen onComplete={() => setShowSplash(false)} />
    )}
    <div style={{ fontFamily: "'DM Sans', sans-serif", height: '100dvh' }}
         className="flex bg-[#080B12] text-gray-100 overflow-hidden"
         onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>

      {/* ══════════════════ SIDEBAR ══════════════════ */}
      {/* ── Mobile sidebar backdrop ─────────────────────────────────────── */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
             onClick={() => setSidebarOpen(false)}/>
      )}

      {/* ══════════════════ SIDEBAR ══════════════════ */}
      {/* Desktop: fixed left column  |  Mobile: slide-in drawer */}
      <aside className={`
        fixed inset-y-0 left-0 z-50 w-72 flex flex-col border-r border-white/5 bg-[#0D1117]
        transition-transform duration-300 ease-in-out
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        md:relative md:translate-x-0 md:flex-shrink-0
      `}>

        {/* Brand */}
        <div className="px-6 pt-7 pb-4">
          <div className="flex items-center gap-2.5 mb-1">
            {/* Close button — mobile only */}
            <button onClick={() => setSidebarOpen(false)}
              className="md:hidden absolute top-4 right-4 w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
              <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold shadow-lg"
                 style={{ background: 'linear-gradient(135deg,#3b82f6,#06b6d4)', boxShadow: '0 4px 14px rgba(59,130,246,0.35)', fontSize:'10px', letterSpacing:'-0.5px' }}>
              A≡B
            </div>
            <span className="text-base font-bold tracking-tight brand-gradient">A≡B</span>
          </div>
          <p className="text-[9px] text-gray-600 uppercase tracking-[0.2em] ml-10">Personal Cloud · v1.0</p>
        </div>

        {/* Keepalive / Cloud Status Banner */}
        {cloudStatus === 'waking' && (
          <div className="mx-4 mb-3 px-3 py-2.5 rounded-xl border border-amber-500/30 bg-amber-500/8 text-amber-300 text-[11px] flex items-center gap-2">
            <svg className="animate-spin w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
            </svg>
            <span>Cloud waking up… retrying in {wakeCountdown}s</span>
          </div>
        )}

        {/* Storage Gauge */}
        <div className="mx-4 mb-4 p-4 rounded-2xl border border-blue-500/10"
             style={{ background: 'linear-gradient(135deg,rgba(37,99,235,0.08),rgba(8,145,178,0.05))' }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Storage</span>
            <span className="text-[10px] text-gray-500">{storagePct}% used</span>
          </div>
          <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden mb-2">
            <div className="h-full rounded-full transition-all duration-700"
                 style={{ width: `${storagePct}%`, background: 'linear-gradient(90deg,#3b82f6,#06b6d4)' }}/>
          </div>
          <div className="flex justify-between text-[10px] mb-3">
            <span className="text-blue-400 font-medium">{formatBytes(totalUsed)} used</span>
            <span className="text-gray-600">{formatBytes(MAX_STORAGE_BYTES - totalUsed)} free</span>
          </div>
          {/* Category breakdown bars */}
          {categories.slice(0, 4).map(([cat, count]) => {
            const meta = getCategoryMeta(cat);
            const catBytes = files.filter(f => f.category === cat).reduce((s, f) => s + (f.size || 0), 0);
            const pct = totalUsed > 0 ? (catBytes / totalUsed) * 100 : 0;
            return (
              <div key={cat} className="mb-1.5">
                <div className="flex justify-between text-[9px] mb-0.5">
                  <span className={`${meta.color} truncate max-w-[120px]`}>{meta.icon} {cat}</span>
                  <span className="text-gray-600">{count}f</span>
                </div>
                <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%`, background: 'rgba(59,130,246,0.5)' }}/>
                </div>
              </div>
            );
          })}
          <div className="pt-2 border-t border-white/5 flex justify-between items-center">
            <span className="text-[10px] text-gray-500">{files.length} file{files.length !== 1 ? 's' : ''}</span>
            <span className="text-[9px] bg-blue-500/15 text-blue-400 px-2 py-0.5 rounded-full border border-blue-500/20">1 GB Plan</span>
          </div>
        </div>

        {/* Upload Button */}
        <div className="px-4 mb-5">
          <button onClick={() => fileInputRef.current?.click()} disabled={isUploading}
            className="w-full py-2.5 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-60"
            style={{ background: isUploading ? 'rgba(59,130,246,0.15)' : 'linear-gradient(135deg,#2563eb,#0891b2)', boxShadow: isUploading ? 'none' : '0 4px 18px rgba(37,99,235,0.3)' }}>
            {isUploading ? (
              <>
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                </svg>
                <span className="truncate text-xs">{uploadStatus || 'Processing...'}</span>
              </>
            ) : (
              <>
                <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
                </svg>
                Upload File
              </>
            )}
          </button>
          <input ref={fileInputRef} type="file" hidden accept=".pdf,.docx,.png,.jpg,.jpeg" onChange={handleUpload}/>

          {isUploading && (
            <div className="mt-2">
              <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all duration-500"
                     style={{ width: `${uploadPct}%`, background: 'linear-gradient(90deg,#3b82f6,#06b6d4)' }}/>
              </div>
            </div>
          )}
          {!isUploading && uploadStatus && (
            <p className="text-[10px] text-emerald-400 text-center mt-2">{uploadStatus}</p>
          )}

          {/* ── Duplicate File Alert ───────────────────────────────────── */}
          {duplicateAlert.show && (
            <div className="mt-3 px-3 py-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300 text-[11px] leading-relaxed">
              <div className="flex items-start gap-2">
                <span className="text-base mt-0.5">✦</span>
                <div>
                  <p className="font-bold">We've got you covered!</p>
                  <p className="text-amber-400/80 mt-0.5">
                    <span className="font-medium">"{duplicateAlert.existingName}"</span> is already in your cloud with identical content. No re-upload needed.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ── Name Conflict → Renamed Alert ─────────────────────────── */}
          {renameAlert.show && (
            <div className="mt-3 px-3 py-2.5 rounded-xl border border-blue-500/30 bg-blue-500/10 text-blue-300 text-[11px] leading-relaxed">
              <div className="flex items-start gap-2">
                <span className="text-base mt-0.5">📝</span>
                <div>
                  <p className="font-bold">Saved with a new name</p>
                  <p className="text-blue-400/80 mt-0.5">
                    A different file named <span className="font-medium">"{renameAlert.original}"</span> already existed, so this was saved as <span className="font-medium">"{renameAlert.savedAs}"</span>.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Scrollable Nav Area: Folders + Find Duplicates + Categories ─────
             Everything between Upload and User Footer lives here.
             flex-1 min-h-0 gives it the remaining space.
             overflow-y-auto makes the ENTIRE block scrollable as one unit.
             User Footer lives OUTSIDE this — always pinned, always visible. */}
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 pb-4">

          {/* Folders */}
          <p className="text-[9px] text-gray-600 uppercase tracking-[0.2em] font-bold mb-2 px-1">Folders</p>
          <button onClick={() => { setActiveFolder('All Folders'); setActiveCategory('All'); }}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-xl mb-1 text-sm transition-all ${
              activeFolder === 'All Folders' ? 'bg-blue-600/15 text-blue-300 border border-blue-500/20' : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
            }`}>
            <div className="flex items-center gap-2.5"><span>📂</span><span className="font-medium">All Folders</span></div>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-md ${activeFolder === 'All Folders' ? 'bg-blue-500/20 text-blue-300' : 'bg-gray-800 text-gray-500'}`}>
              {files.filter(f => !f.is_archived).length}
            </span>
          </button>
          {(['My Cloud', 'Finance', 'Health', 'Work', 'Personal'] as const).map(folder => {
            const count = files.filter(f => !f.is_archived && f.folder === folder).length;
            const icons: Record<string, string> = { 'My Cloud': '☁️', Finance: '💰', Health: '❤️', Work: '💼', Personal: '🏠' };
            const isActive = activeFolder === folder;
            return (
              <button key={folder} onClick={() => { setActiveFolder(folder); setActiveCategory('All'); }}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-xl mb-1 text-sm transition-all ${isActive ? 'bg-white/8 text-white border border-white/12' : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'}`}>
                <div className="flex items-center gap-2.5"><span>{icons[folder]}</span><span className="font-medium">{folder}</span></div>
                {count > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-gray-800 text-gray-500">{count}</span>}
              </button>
            );
          })}
          <button onClick={() => { setActiveFolder('Archive'); setActiveCategory('All'); }}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-xl mb-1 text-sm transition-all ${activeFolder === 'Archive' ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20' : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'}`}>
            <div className="flex items-center gap-2.5"><span>📦</span><span className="font-medium">Archive</span></div>
            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-gray-800 text-gray-500">{files.filter(f => f.is_archived).length}</span>
          </button>

          {/* Timeline */}
          <button onClick={handleOpenTimeline}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-gray-400 hover:text-violet-300 hover:bg-violet-500/10 border border-transparent hover:border-violet-500/20 transition-all mt-1">
            <span>📅</span>
            <span className="font-medium">Personal Timeline</span>
          </button>

          {/* Privacy Scanner */}
          <button onClick={handleSensitivityScan} disabled={sensitivityLoading}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-gray-400 hover:text-red-300 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 transition-all disabled:opacity-40 mt-1">
            <span>🔒</span>
            <span className="font-medium">{sensitivityLoading ? 'Scanning...' : 'Privacy Scan'}</span>
          </button>

          {/* Find Duplicates */}
          <button onClick={handleSemanticDupeScan} disabled={dupePanel.scanning || files.length < 2}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-gray-400 hover:text-orange-300 hover:bg-orange-500/10 hover:border-orange-500/20 border border-transparent transition-all disabled:opacity-40 mt-1 mb-4">
            {dupePanel.scanning
              ? <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
              : <span>🔍</span>}
            <span className="font-medium">{dupePanel.scanning ? 'Scanning...' : 'Find Duplicates'}</span>
          </button>

          {/* Divider between folders and categories */}
          <div className="h-px bg-white/5 mb-3"/>

          {/* Categories */}
          <p className="text-[9px] text-gray-600 uppercase tracking-[0.2em] font-bold mb-2 px-1">Categories</p>

          <button onClick={() => setActiveCategory('All')}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-xl mb-1 text-sm transition-all ${
              activeCategory === 'All'
                ? 'bg-blue-600/15 text-blue-300 border border-blue-500/20'
                : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
            }`}>
            <div className="flex items-center gap-2.5">
              <span>📂</span><span className="font-medium">All Files</span>
            </div>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-md ${activeCategory === 'All' ? 'bg-blue-500/20 text-blue-300' : 'bg-gray-800 text-gray-500'}`}>
              {files.length}
            </span>
          </button>

          {categories.map(([cat, count]) => {
            const meta     = getCategoryMeta(cat);
            const isActive = activeCategory === cat;
            return (
              <button key={cat} onClick={() => setActiveCategory(cat)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-xl mb-1 text-sm transition-all ${
                  isActive ? `${meta.bg} ${meta.color} border ${meta.border}` : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
                }`}>
                <div className="flex items-center gap-2.5">
                  <span>{meta.icon}</span>
                  <span className="font-medium truncate max-w-[120px]">{cat}</span>
                </div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-md flex-shrink-0 ${isActive ? `${meta.bg} ${meta.color}` : 'bg-gray-800 text-gray-500'}`}>
                  {count}
                </span>
              </button>
            );
          })}

          {categories.length === 0 && (
            <p className="text-[11px] text-gray-600 italic px-3 py-4 text-center">Upload files to see categories</p>
          )}
        </div>

        {/* User Footer — always visible, never scrolled away */}
        <div className="flex-shrink-0 p-4 border-t border-white/5 bg-[#0D1117]">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                 style={{ background: 'linear-gradient(135deg,#3b82f6,#06b6d4)' }}>
              {userEmail?.[0]?.toUpperCase() || 'U'}
            </div>
            <span className="text-[11px] text-gray-400 truncate">{userEmail}</span>
          </div>
          <button onClick={() => supabase.auth.signOut().then(() => { sessionStorage.removeItem('splash_seen'); router.push('/login'); })}
            className="w-full text-xs text-gray-500 hover:text-gray-300 flex items-center gap-2 px-2 py-1.5 hover:bg-white/5 rounded-lg transition-all">
            <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
            </svg>
            Sign out
          </button>
        </div>
      </aside>

      {/* ══════════════════ MAIN ══════════════════ */}
      <main className="flex-1 flex flex-col min-w-0 md:ml-0">

        {/* Top Bar */}
        <div className="flex-shrink-0 flex items-center justify-between px-4 md:px-6 py-3 md:py-4 border-b border-white/5 bg-[#0D1117]/80 backdrop-blur-xl gap-3">
          {/* Hamburger — mobile only */}
          <button onClick={() => setSidebarOpen(true)}
            className="md:hidden w-9 h-9 flex items-center justify-center rounded-xl bg-white/5 border border-white/8 text-gray-400 hover:text-gray-200 flex-shrink-0 transition-all">
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16"/>
            </svg>
          </button>

          {/* Search — always visible on mobile */}
          <div className={`relative flex-1 min-w-0 max-w-md ${chatOpen ? 'hidden md:flex' : 'flex'}`}>
            <div className="search-ring flex items-center gap-3 bg-white/5 border border-white/8 rounded-xl px-4 py-2.5 transition-all">
              <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-500 flex-shrink-0" viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
              <input
                type="search"
                placeholder="Search files..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
                onFocus={() => liveMatches.length > 0 && setShowDropdown(true)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="bg-transparent text-sm text-gray-200 placeholder-gray-600 outline-none w-full min-w-0"/>
              {searchQuery && (
                <button onClick={() => { setSearchQuery(''); setShowDropdown(false); }} className="text-gray-600 hover:text-gray-400">
                  <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
                </button>
              )}
            </div>

            {/* Live Dropdown */}
            {showDropdown && (
              <div className="absolute top-full left-0 right-0 mt-2 bg-[#161B27] border border-white/10 rounded-2xl overflow-hidden shadow-2xl z-50">
                <div className="px-4 py-2 border-b border-white/5">
                  <span className="text-[9px] text-gray-500 uppercase tracking-wider">{liveMatches.length} matching files</span>
                </div>
                {liveMatches.map(f => {
                  const meta = getCategoryMeta(f.category);
                  return (
                    <button key={f.id} onMouseDown={() => {
                      setSelectedFiles([f.id]);
                      setChatOpen(true);
                      setShowDropdown(false);
                      setSearchQuery('');
                    }}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-all text-left">
                      <span className="text-xl">{getFileIcon(f.type, f.name)}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-200 truncate">{f.name}</p>
                        <p className="text-[10px] text-gray-500">{f.category} · {formatBytes(f.size)}</p>
                      </div>
                      <span className={`text-[9px] px-2 py-0.5 rounded-full ${meta.bg} ${meta.color} border ${meta.border}`}>
                        {meta.icon}
                      </span>
                    </button>
                  );
                })}
                <p className="text-[9px] text-gray-600 px-4 py-2 border-t border-white/5">Click to open in AI chat</p>
              </div>
            )}
          </div>

          {/* Right controls */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {selectedFiles.length > 0 && (
              <div className="flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"/>
                <span className="text-xs text-blue-300 font-medium">{selectedFiles.length} selected</span>
                <button onClick={() => setSelectedFiles([])} className="text-blue-400/60 hover:text-blue-300 ml-1">
                  <svg width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
                </button>
              </div>
            )}

            <div className="flex items-center bg-white/5 rounded-lg p-1 border border-white/8">
              {(['grid', 'list'] as const).map(mode => (
                <button key={mode} onClick={() => setViewMode(mode)}
                  className={`px-2.5 py-1 rounded-md text-xs transition-all ${viewMode === mode ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                  {mode === 'grid' ? '⊞' : '≡'}
                </button>
              ))}
            </div>

            {/* Knowledge Graph Button — hidden on mobile */}
            <button onClick={() => setGraphOpen(true)} title="Knowledge Graph"
              className="hidden md:flex relative w-9 h-9 items-center justify-center rounded-xl bg-white/5 border border-white/8 text-gray-400 hover:text-violet-300 hover:border-violet-500/30 hover:bg-violet-500/10 transition-all">
              <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                <circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/>
                <path d="M12 7v4m-5.27 6.27L10 14m3.97 0 2.3 3.27"/>
              </svg>
            </button>

            {/* Alerts Bell */}
            <button onClick={() => { setAlertsOpen(!alertsOpen); if (unreadCount > 0) { fetch('/api/alerts', { method: 'PATCH', headers: {'Content-Type':'application/json', 'Authorization': `Bearer ${tokenRef.current}`}, body: JSON.stringify({ markAllRead: true }) }); setUnreadCount(0); setAlerts(prev => prev.map(a => ({...a, is_read: true}))); } }}
              className="relative w-9 h-9 flex items-center justify-center rounded-xl bg-white/5 border border-white/8 text-gray-400 hover:text-amber-300 hover:border-amber-500/30 hover:bg-amber-500/10 transition-all">
              <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 17H9a6 6 0 01-1-3.35V10a5 5 0 0110 0v3.65A6 6 0 0115 17zM13.73 21a2 2 0 01-3.46 0"/>
              </svg>
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 text-[9px] text-black font-bold rounded-full flex items-center justify-center">{unreadCount}</span>
              )}
            </button>

            <button onClick={() => setChatOpen(!chatOpen)}
              className={`flex items-center gap-2 px-3 md:px-4 py-2 rounded-xl text-sm font-semibold transition-all border ${
                chatOpen
                  ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/25'
                  : 'bg-white/5 text-gray-300 border-white/8 hover:bg-white/10'
              }`}>
              <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/>
              </svg>
              {chatOpen ? 'Close Chat' : 'Ask AI'}
              {chatHistory.length > 0 && (
                <span className="w-4 h-4 bg-cyan-500 text-[9px] text-black rounded-full flex items-center justify-center font-bold">
                  {chatHistory.filter(m => m.role === 'assistant').length}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex flex-1 min-h-0">

          {/* File Grid / List */}
          <div className="flex-1 overflow-y-auto px-4 md:px-8 py-4 md:py-6 custom-scrollbar">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-bold">
                  {activeCategory === 'All' ? 'All Files' : activeCategory}
                </h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  {displayedFiles.length} file{displayedFiles.length !== 1 ? 's' : ''}
                  {searchQuery && ` matching "${searchQuery}"`}
                </p>
              </div>
              {selectedFiles.length > 0 && (
                <button onClick={() => setChatOpen(true)}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold hover:opacity-90 transition-all"
                  style={{ background: 'linear-gradient(135deg,#2563eb,#0891b2)', boxShadow: '0 4px 14px rgba(37,99,235,0.25)' }}>
                  <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/>
                  </svg>
                  Chat with {selectedFiles.length} file{selectedFiles.length > 1 ? 's' : ''}
                </button>
              )}
            </div>

            {/* Skeleton Loader — shown while files are being fetched */}
            {isLoadingFiles && (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3 md:gap-4">
                {[...Array(6)].map((_, i) => (
                  <div key={i} className="p-4 rounded-2xl border border-white/5 bg-white/2">
                    <div className="skeleton w-10 h-10 rounded-xl mb-3"/>
                    <div className="skeleton h-3 w-3/4 rounded mb-2"/>
                    <div className="skeleton h-2 w-1/2 rounded mb-4"/>
                    <div className="skeleton h-5 w-16 rounded-full"/>
                  </div>
                ))}
              </div>
            )}

            {/* Empty State */}
            {!isLoadingFiles && displayedFiles.length === 0 && (
              <div className="flex flex-col items-center justify-center py-28 text-center">
                <div className="w-20 h-20 rounded-3xl bg-white/5 border border-white/8 flex items-center justify-center mb-5 text-3xl">
                  {activeCategory === 'All' ? '☁️' : getCategoryMeta(activeCategory).icon}
                </div>
                <h3 className="text-base font-semibold text-gray-300 mb-2">
                  {searchQuery ? `No results for "${searchQuery}"` : activeCategory === 'All' ? 'Your cloud is empty' : `No ${activeCategory} files yet`}
                </h3>
                <p className="text-sm text-gray-600 max-w-xs">
                  {searchQuery ? 'Try different keywords.' : 'Upload a PDF, image, or DOCX to begin.'}
                </p>
              </div>
            )}

            {/* GRID VIEW */}
            {viewMode === 'grid' && !isLoadingFiles && displayedFiles.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3 md:gap-4">
                {displayedFiles.map(file => {
                  const meta       = getCategoryMeta(file.category);
                  const isSelected = selectedFiles.includes(file.id);
                  const isDeleting = deletingId === file.id;
                  return (
                    <div key={file.id} onClick={() => toggleFileSelect(file.id)} onDoubleClick={() => openPreview(file)}
                      title="Click to select · Double-click to preview"
                      className={`card-enter file-card group relative p-4 rounded-2xl border cursor-pointer transition-all duration-200 overflow-visible ${
                        isSelected
                          ? 'border-blue-500/40 shadow-lg'
                          : 'border-white/8 hover:border-white/15'
                      }`}
                      style={{
                        animationDelay: `${displayedFiles.indexOf(file) * 40}ms`,
                        background: isSelected ? 'rgba(59,130,246,0.08)' : 'rgba(255,255,255,0.025)',
                        boxShadow: isSelected ? '0 0 0 1px rgba(59,130,246,0.2), 0 8px 24px rgba(59,130,246,0.08)' : 'none'
                      }}>

                      {/* Checkbox */}
                      <div className={`absolute top-3 right-3 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
                        isSelected ? 'bg-blue-500 border-blue-500' : 'border-gray-700 group-hover:border-gray-500'
                      }`}>
                        {isSelected && (
                          <svg width="10" height="10" fill="none" stroke="white" strokeWidth="3" viewBox="0 0 24 24">
                            <path d="M20 6 9 17l-5-5"/>
                          </svg>
                        )}
                      </div>

                      {/* Icon */}
                      <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-2xl mb-3 ${meta.bg} border ${meta.border}`}>
                        {getFileIcon(file.type, file.name)}
                      </div>

                      <p className="text-sm font-semibold text-gray-200 truncate mb-1 pr-6">{file.name}</p>
                      <p className="text-[10px] text-gray-500 mb-3">{formatBytes(file.size)} · {timeAgo(file.created_at)}</p>

                      <div className="flex flex-wrap gap-1 items-center">
                        <span className={`text-[9px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wide ${meta.bg} ${meta.color} border ${meta.border} cursor-pointer hover:opacity-80 transition-all`}
                          onClick={e => { e.stopPropagation(); setReclassifyFile(reclassifyFile === file.id ? null : file.id); }}
                          title="Click to correct category">
                          {meta.icon} {file.category}
                        </span>
                        {/* Reclassify dropdown — backdrop + high z-index so grid cards below don't intercept */}
                        {reclassifyFile === file.id && (
                          <>
                            {/* Transparent full-screen backdrop — click anywhere outside to close */}
                            <div
                              className="fixed inset-0 z-[499]"
                              onClick={e => { e.stopPropagation(); setReclassifyFile(null); }}
                            />
                            {/* Dropdown floats above everything */}
                            <div
                              className="absolute left-0 top-full mt-1 z-[500] bg-[#161B27] border border-white/15 rounded-xl shadow-2xl p-2 w-60"
                              onClick={e => e.stopPropagation()}>
                              <div className="flex items-center justify-between px-1 mb-2">
                                <p className="text-[9px] text-gray-400 uppercase tracking-wider font-bold">Correct category</p>
                                <button
                                  onClick={e => { e.stopPropagation(); setReclassifyFile(null); }}
                                  className="text-gray-600 hover:text-gray-300 transition-all">
                                  <svg width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
                                </button>
                              </div>
                              <div className="max-h-52 overflow-y-auto custom-scrollbar space-y-0.5">
                                {Object.keys(CATEGORY_META).map(cat => (
                                  <button key={cat}
                                    onClick={e => { e.stopPropagation(); handleReclassify(file.id, cat); }}
                                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-left transition-all hover:bg-white/8 ${cat === file.category ? 'bg-blue-500/10 text-blue-300' : 'text-gray-300'}`}>
                                    <span className="flex-shrink-0">{getCategoryMeta(cat).icon}</span>
                                    <span className="flex-1 truncate">{cat}</span>
                                    {cat === file.category && <span className="text-[8px] text-blue-400 flex-shrink-0">✓ current</span>}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </>
                        )}
                        {(file.tags || []).slice(0, 2).map((tag, i) => (
                          <span key={i} className="text-[9px] px-2 py-0.5 rounded-full bg-white/5 text-gray-500 border border-white/8">#{tag}</span>
                        ))}
                      </div>

                      {/* Delete */}
                      <button onClick={e => { e.stopPropagation(); handleDelete(file.id, file.name); }}
                        disabled={isDeleting}
                        className="absolute bottom-3 right-3 opacity-0 group-hover:opacity-100 w-7 h-7 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 flex items-center justify-center transition-all">
                        {isDeleting
                          ? <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                          : <svg width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        }
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* LIST VIEW */}
            {viewMode === 'list' && !isLoadingFiles && displayedFiles.length > 0 && (
              <div className="space-y-2">
                <div className="grid grid-cols-12 px-4 py-2 text-[9px] text-gray-600 uppercase tracking-wider">
                  <div className="col-span-1"/>
                  <div className="col-span-5">Name</div>
                  <div className="col-span-2">Category</div>
                  <div className="col-span-2">Size</div>
                  <div className="col-span-2">Uploaded</div>
                </div>
                {displayedFiles.map(file => {
                  const meta       = getCategoryMeta(file.category);
                  const isSelected = selectedFiles.includes(file.id);
                  const isDeleting = deletingId === file.id;
                  return (
                    <div key={file.id} onClick={() => toggleFileSelect(file.id)}
                      className={`group grid grid-cols-12 items-center px-4 py-3 rounded-xl border cursor-pointer transition-all ${
                        isSelected ? 'border-blue-500/30 bg-blue-500/8' : 'border-white/6 bg-white/2 hover:bg-white/5 hover:border-white/12'
                      }`}>
                      <div className="col-span-1">
                        <div className={`w-4 h-4 rounded border-2 flex items-center justify-center ${isSelected ? 'bg-blue-500 border-blue-500' : 'border-gray-700'}`}>
                          {isSelected && <svg width="8" height="8" fill="none" stroke="white" strokeWidth="3" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>}
                        </div>
                      </div>
                      <div className="col-span-5 flex items-center gap-3">
                        <span className="text-lg">{getFileIcon(file.type, file.name)}</span>
                        <span className="text-sm font-medium text-gray-200 truncate">{file.name}</span>
                      </div>
                      <div className="col-span-2">
                        <span className={`text-[9px] px-2 py-0.5 rounded-full font-bold ${meta.bg} ${meta.color} border ${meta.border}`}>
                          {meta.icon} {file.category}
                        </span>
                      </div>
                      <div className="col-span-2 text-xs text-gray-500">{formatBytes(file.size)}</div>
                      <div className="col-span-2 flex items-center justify-between">
                        <span className="text-xs text-gray-500">{timeAgo(file.created_at)}</span>
                        <button onClick={e => { e.stopPropagation(); handleDelete(file.id, file.name); }}
                          disabled={isDeleting}
                          className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-all">
                          <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                          </svg>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ══════════════════ CHAT PANEL ══════════════════ */}
          {/* Chat Panel — full screen on mobile, 400px side panel on desktop */}
          <div className={`
            flex-shrink-0 flex flex-col border-l border-white/5 bg-[#0D1117]
            transition-all duration-300 ease-in-out overflow-hidden
            ${chatOpen
              ? 'fixed inset-0 z-50 w-full md:relative md:inset-auto md:z-auto md:w-[400px]'
              : 'w-0'}
          `}>
            {chatOpen && (
              <div className="chat-slide-in flex flex-col flex-1 min-h-0">
                {/* Chat Header */}
                <div className="flex-shrink-0 px-5 py-4 border-b border-white/5">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      {/* Back to files — mobile only */}
                      <button
                        onClick={() => setChatOpen(false)}
                        className="flex md:hidden items-center gap-1 text-gray-400 hover:text-gray-200 mr-1 p-1 rounded-lg hover:bg-white/5 transition-all">
                        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6"/>
                        </svg>
                        <span className="text-xs font-medium">Files</span>
                      </button>
                      <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"/>
                      <span className="text-sm font-bold">AI Assistant</span>
                    </div>
                    <button onClick={() => {
                      setChatHistory([]); setSelectedFiles([]);
                      fetch('/api/conversations', { method: 'DELETE', headers: authHeaders() }).catch(() => {});
                    }}
                      className="text-[10px] text-gray-500 hover:text-gray-300 flex items-center gap-1 px-2 py-1 hover:bg-white/5 rounded-lg transition-all">
                      <svg width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>
                      </svg>
                      New chat
                    </button>
                  </div>

                  {selectedFiles.length > 0 ? (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {selectedFiles.map(id => {
                        const f = files.find(x => x.id === id);
                        if (!f) return null;
                        return (
                          <span key={id} className="flex items-center gap-1 text-[10px] bg-blue-500/10 text-blue-300 border border-blue-500/20 px-2 py-0.5 rounded-full">
                            {getFileIcon(f.type, f.name)} {f.name.slice(0, 18)}{f.name.length > 18 ? '…' : ''}
                            <button onClick={() => toggleFileSelect(id)} className="hover:text-red-300 ml-0.5">×</button>
                          </span>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-[10px] text-gray-600 mt-1">No files selected · searching entire cloud</p>
                  )}
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 custom-scrollbar">
                  {chatHistory.length === 0 && (
                    <>
                      <div className="text-center py-4 opacity-50">
                        <div className="text-3xl mb-2">🧠</div>
                        <p className="text-sm font-medium text-gray-300">Ask me anything</p>
                        <p className="text-xs text-gray-500 mt-1">
                          {selectedFiles.length > 0 ? `${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''} selected` : 'No files selected · try a general question'}
                        </p>
                      </div>

                      {/* File-scoped suggestions — only shown when ≥1 file selected */}
                      {selectedFiles.length > 0 && (
                        <div className="mb-3">
                          <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-2 px-1">About selected files</p>
                          <div className="flex flex-wrap gap-2">
                            {['Summarize this file', 'What is on page 1?', 'Find key points', 'List all topics'].map(s => (
                              <button key={s} onClick={() => setChatMessage(s)}
                                className="text-[11px] bg-blue-500/10 border border-blue-500/20 text-blue-300 px-3 py-1.5 rounded-full hover:bg-blue-500/20 transition-all">
                                {s}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* General suggestions — always visible */}
                      <div>
                        <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-2 px-1">General questions</p>
                        <div className="flex flex-wrap gap-2">
                          {["What's today's date?", 'What is AI?', 'Explain Machine Learning', 'What files do I have?'].map(s => (
                            <button key={s} onClick={() => setChatMessage(s)}
                              className="text-[11px] bg-white/5 border border-white/8 text-gray-400 px-3 py-1.5 rounded-full hover:bg-white/10 hover:text-gray-200 transition-all">
                              {s}
                            </button>
                          ))}
                        </div>
                      </div>
                    </>
                  )}

                  {chatHistory.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      {msg.role === 'assistant' && (
                        <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold mr-2 mt-1 flex-shrink-0"
                             style={{ background: 'linear-gradient(135deg,#3b82f6,#06b6d4)' }}>S</div>
                      )}
                      <div className="max-w-[85%] flex flex-col gap-2">
                        <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed ${
                          msg.role === 'user'
                            ? 'bg-blue-600 text-white rounded-br-sm whitespace-pre-wrap'
                            : 'bg-white/5 border border-white/8 text-gray-200 rounded-bl-sm'
                        }`}>
                          {msg.role === 'user'
                            ? msg.content
                            : <div className="md-content" style={{userSelect:'text',cursor:'text'}} dangerouslySetInnerHTML={{ __html: '<p class=\"md-p\">' + renderMarkdown(msg.content) + '</p>' }}/>
                          }
                        </div>
                        {/* Synthesis download button */}
                        {msg.role === 'assistant' && (msg as any).isSynthesis && (
                          <div className="flex gap-2">
                            <button onClick={() => {
                              const blob = new Blob([msg.content], { type: 'text/markdown' });
                              const url  = URL.createObjectURL(blob);
                              const a    = document.createElement('a'); a.href = url;
                              a.download = 'synthesised-document.md'; a.click(); URL.revokeObjectURL(url);
                            }}
                              className="self-start flex items-center gap-1.5 text-[10px] text-emerald-400 border border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 rounded-lg hover:bg-emerald-500/20 transition-all">
                              <svg width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                              </svg>
                              Download .md
                            </button>
                            <button onClick={() => handleDownloadPDF((msg as any).content)}
                              className="self-start flex items-center gap-1.5 text-[10px] text-violet-400 border border-violet-500/25 bg-violet-500/10 px-3 py-1.5 rounded-lg hover:bg-violet-500/20 transition-all">
                              <svg width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/>
                              </svg>
                              Download PDF
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}

                  {isChatting && (
                    <div className="flex items-start gap-2">
                      <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0"
                           style={{ background: 'linear-gradient(135deg,#3b82f6,#06b6d4)' }}>S</div>
                      <div className="bg-white/5 border border-white/8 rounded-2xl rounded-bl-sm px-4 py-3">
                        <div className="flex gap-1.5 items-center h-4">
                          {[0,150,300].map(d => (
                            <div key={d} className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: `${d}ms` }}/>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef}/>
                </div>

                {/* Chat Input */}
                <div className="flex-shrink-0 p-4 border-t border-white/5">
                  <div className="flex items-end gap-2 bg-white/5 border border-white/10 rounded-xl p-2">
                    <textarea value={chatMessage}
                      onChange={e => setChatMessage(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChat(); } }}
                      placeholder="Ask about your files or anything... ↵ to send"
                      disabled={isChatting}
                      rows={1}
                      className="flex-1 bg-transparent text-sm text-gray-200 placeholder-gray-600 outline-none resize-none max-h-24"
                      style={{ lineHeight: '1.5' }}/>
                    {/* Voice mic button */}
                    <button onClick={startVoice} title={isListening ? 'Stop listening' : 'Voice input'}
                      className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-all ${isListening ? 'bg-red-500/20 border border-red-500/40' : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'}`}>
                      {isListening
                        ? <span className="w-2 h-2 rounded-full bg-red-500 animate-ping"/>
                        : <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect width="10" height="14" x="7" y="2" rx="5"/><path d="M3 12s0 8 9 8 9-8 9-8"/><path d="M12 20v4"/></svg>}
                    </button>
                    <button onClick={handleChat} disabled={isChatting || !chatMessage.trim()}
                      className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 disabled:opacity-40 transition-all"
                      style={{ background: 'linear-gradient(135deg,#2563eb,#0891b2)' }}>
                      <svg width="14" height="14" fill="white" viewBox="0 0 16 16">
                        <path d="M15.854.146a.5.5 0 0 1 .11.54l-5.819 14.547a.75.75 0 0 1-1.329.124l-3.178-4.995L.643 7.184a.75.75 0 0 1 .124-1.33L15.314.037a.5.5 0 0 1 .54.11z"/>
                      </svg>
                    </button>
                  </div>
                  <div className="flex items-center justify-between mt-2 px-1">
                    <p className="text-[9px] text-gray-600">
                      Llama 4 Scout · Voyage-3 · {selectedFiles.length > 0 ? `${selectedFiles.length} file${selectedFiles.length>1?'s':''} focused` : 'Full cloud search'}
                    </p>
                    <span className="text-[9px] flex items-center gap-1 opacity-70 transition-all"
                      style={{ color: memoryFacts > 0 ? '#a78bfa' : '#4b5563' }}>
                      <span>🧠</span>
                      {memoryFacts > 0 ? `${memoryFacts} memories` : 'building memory...'}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>



      {/* ══════════════════ DRAG & DROP OVERLAY ══════════════════ */}
      {isDragOver && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none">
          <div className="absolute inset-0 bg-blue-500/10 border-2 border-dashed border-blue-400/60 rounded-none"/>
          <div className="relative bg-[#0D1117] border border-blue-500/40 rounded-3xl px-12 py-8 text-center shadow-2xl">
            <div className="text-5xl mb-3">☁️</div>
            <p className="text-blue-300 font-bold text-lg">Drop to upload</p>
            <p className="text-gray-500 text-sm mt-1">PDF, DOCX, PNG, JPG supported</p>
          </div>
        </div>
      )}

      {/* ══════════════════ TOAST NOTIFICATIONS ══════════════════ */}
      <div className="fixed bottom-6 right-6 z-[200] flex flex-col gap-2 pointer-events-none">
        {toasts.map(toast => (
          <div key={toast.id} className={`flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-medium shadow-2xl border pointer-events-auto
            animate-in slide-in-from-bottom-2 fade-in duration-300
            ${toast.type === 'success' ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
            : toast.type === 'error'   ? 'bg-red-500/15 border-red-500/30 text-red-300'
            : toast.type === 'warning' ? 'bg-amber-500/15 border-amber-500/30 text-amber-300'
            :                            'bg-blue-500/15 border-blue-500/30 text-blue-300'}`}>
            <span>{toast.type === 'success' ? '✅' : toast.type === 'error' ? '❌' : toast.type === 'warning' ? '⚠️' : 'ℹ️'}</span>
            <span>{toast.message}</span>
          </div>
        ))}
      </div>

      {/* ══════════════════ FILE PREVIEW PANEL (enhanced) ══════════════════ */}
      {previewFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => { setPreviewFile(null); setPreviewContent(''); setPreviewTab('info'); setPreviewSignedUrl(null); }}>
          <div className="relative bg-[#0D1117] border border-white/10 rounded-3xl w-[680px] max-h-[85vh] flex flex-col overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
              <div className="flex items-center gap-3 min-w-0">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0 ${getCategoryMeta(previewFile.category).bg} border ${getCategoryMeta(previewFile.category).border}`}>
                  {getFileIcon(previewFile.type, previewFile.name)}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-gray-100 truncate max-w-xs">{previewFile.name}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">
                    {getCategoryMeta(previewFile.category).icon} {previewFile.category}
                    {' · '}{formatBytes(previewFile.size)}
                    {' · '}{timeAgo(previewFile.created_at)}
                    {previewFile.folder && previewFile.folder !== 'My Cloud' && ` · 📂 ${previewFile.folder}`}
                  </p>
                </div>
              </div>
              <button onClick={() => { setPreviewFile(null); setPreviewContent(''); setPreviewTab('info'); setPreviewSignedUrl(null); }}
                className="w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center flex-shrink-0 transition-all">
                <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>

            {/* Tabs: Info / AI Content */}
            {(() => {
              const [activeTab, setActiveTab] = (window as any).__previewTab
                ? [(window as any).__previewTab, (v: string) => { (window as any).__previewTab = v; }]
                : ['info', () => {}];
              return null; // handled via previewContent state — info shown when empty
            })()}

            <div className="flex-1 overflow-y-auto custom-scrollbar">
              <div className="px-6 pt-5 pb-3 space-y-4">

                {/* ── Inline file viewer ─────────────────────────────── */}
                {/* PDF: rendered inline via iframe — scroll to see all pages */}
                {previewFile.type === 'application/pdf' && (
                  <div className="rounded-2xl overflow-hidden border border-white/8" style={{ height: '420px' }}>
                    {previewUrlLoading ? (
                      <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-500 text-sm bg-white/2">
                        <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                        </svg>
                        Loading document…
                      </div>
                    ) : previewSignedUrl ? (
                      <iframe
                        src={previewSignedUrl}
                        className="w-full h-full border-0 bg-white rounded-b-2xl"
                        title={previewFile.name}
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-600 text-xs bg-white/2 text-center px-6">
                        <span className="text-3xl opacity-40">📄</span>
                        <p className="text-gray-400 text-sm font-medium">Document preview unavailable</p>
                        <p>Re-upload this file to enable inline viewing</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Image: shown inline, full width */}
                {previewFile.type?.startsWith('image/') && (
                  <div className="rounded-2xl overflow-hidden border border-white/8 bg-white/2 flex items-center justify-center" style={{ minHeight: '200px' }}>
                    {previewUrlLoading ? (
                      <div className="flex items-center gap-2 text-gray-500 text-sm p-8">
                        <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                        </svg>
                        Loading image…
                      </div>
                    ) : previewSignedUrl ? (
                      <img
                        src={previewSignedUrl}
                        alt={previewFile.name}
                        className="max-w-full max-h-80 object-contain rounded-xl"
                      />
                    ) : (
                      <div className="text-gray-600 text-xs p-8 text-center">
                        <span className="text-3xl block mb-2 opacity-40">🖼️</span>
                        Re-upload to enable preview
                      </div>
                    )}
                  </div>
                )}

                {/* Metadata grid */}
                <div className="grid grid-cols-2 gap-2.5">
                  {[
                    ['Type',     previewFile.type?.split('/')[1]?.toUpperCase() || 'Unknown'],
                    ['Size',     formatBytes(previewFile.size)],
                    ['Uploaded', new Date(previewFile.created_at).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' })],
                    ['Folder',   previewFile.folder || 'My Cloud'],
                  ].map(([k, v]) => (
                    <div key={k} className="bg-white/3 rounded-xl p-3 border border-white/5">
                      <p className="text-gray-600 text-[9px] uppercase tracking-wider mb-1">{k}</p>
                      <p className="text-gray-200 text-xs font-medium truncate">{v}</p>
                    </div>
                  ))}
                </div>

                {/* Tags */}
                {(previewFile.tags || []).length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {(previewFile.tags || []).map((tag: string, i: number) => (
                      <span key={i} className="text-[10px] px-2 py-1 rounded-lg bg-white/5 text-gray-400 border border-white/8">#{tag}</span>
                    ))}
                  </div>
                )}

                {/* DOCX: cannot render natively in browser — show notice */}
                {previewFile.type?.includes('wordprocessingml') && (
                  <div className="rounded-2xl border border-white/8 bg-white/2 px-5 py-4 flex items-center gap-3">
                    <span className="text-2xl">📘</span>
                    <div>
                      <p className="text-sm text-gray-200 font-medium">Word Document</p>
                      <p className="text-xs text-gray-500 mt-0.5">Browsers can't render DOCX natively. Use Download to open in Word, or Ask AI to read the content below.</p>
                    </div>
                  </div>
                )}

                {/* AI-extracted text — always shown below the viewer */}
                <div className="border border-white/8 rounded-2xl overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5 bg-white/2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs">🧠</span>
                      <span className="text-[11px] font-semibold text-gray-400">AI-Extracted Content</span>
                    </div>
                    {previewContent && (
                      <span className="text-[9px] text-gray-600">{previewContent.length.toLocaleString()} chars indexed</span>
                    )}
                  </div>
                  <div className="p-4 min-h-[80px]">
                    {previewLoading ? (
                      <div className="space-y-2">
                        {[...Array(4)].map((_, i) => (
                          <div key={i} className={`skeleton h-2.5 rounded ${i === 3 ? 'w-1/2' : 'w-full'}`}/>
                        ))}
                      </div>
                    ) : previewContent ? (
                      (() => {
                        const lines = previewContent.split('\n').filter(l => l.trim());
                        const isAllImages = lines.length > 0 && lines.every(l => l.includes('no extractable text'));
                        return isAllImages ? (
                          <div className="flex flex-col items-center justify-center gap-2 py-4 text-center">
                            <span className="text-2xl">🖼️</span>
                            <p className="text-xs text-gray-300 font-medium">Scanned or image-based PDF</p>
                            <p className="text-[10px] text-gray-500 max-w-xs leading-relaxed">
                              This PDF stores content as images — no selectable text could be extracted.
                              You can still view it using the inline viewer above, or Ask AI to describe it.
                            </p>
                          </div>
                        ) : (
                          <pre className="text-[11px] text-gray-300 leading-relaxed whitespace-pre-wrap font-mono overflow-auto" style={{ maxHeight: '260px' }}>
                            {previewContent}
                          </pre>
                        );
                      })()
                    ) : (
                      <div className="flex items-center justify-center h-16 text-gray-600 text-xs">
                        No content extracted yet
                      </div>
                    )}
                  </div>
                </div>

              </div>
            </div>

            {/* Action footer */}
            <div className="flex gap-2 p-4 border-t border-white/5">
              <button
                onClick={() => handleDownloadFile(previewFile)}
                disabled={downloadingId === previewFile.id}
                className="px-4 py-2.5 rounded-xl text-sm font-semibold text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 hover:bg-emerald-500/20 transition-all flex items-center gap-2 disabled:opacity-50">
                {downloadingId === previewFile.id
                  ? <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                  : <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>}
                Download
              </button>
              <button
                onClick={() => { toggleFileSelect(previewFile.id); setChatOpen(true); setPreviewFile(null); setPreviewContent(''); setPreviewTab('info'); setPreviewSignedUrl(null); }}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white transition-all flex items-center justify-center gap-2"
                style={{ background: 'linear-gradient(135deg,#2563eb,#0891b2)' }}>
                <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/>
                </svg>
                Ask AI about this file
              </button>
              <button
                onClick={() => handleDelete(previewFile.id, previewFile.name)}
                className="px-4 py-2.5 rounded-xl text-sm text-red-400 hover:text-red-300 bg-red-500/8 hover:bg-red-500/15 border border-red-500/20 transition-all">
                Delete
              </button>
              <button onClick={() => { setPreviewFile(null); setPreviewContent(''); setPreviewTab('info'); setPreviewSignedUrl(null); }}
                className="px-4 py-2.5 rounded-xl text-sm text-gray-400 hover:text-gray-200 bg-white/5 hover:bg-white/10 transition-all">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ══════════════════ KNOWLEDGE GRAPH MODAL ══════════════════ */}
      {graphOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setGraphOpen(false)}>
          <div className="relative bg-[#0D1117] border border-white/10 rounded-3xl w-[90vw] h-[85vh] flex flex-col overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-7 py-5 border-b border-white/5">
              <div>
                <h2 className="text-base font-bold">Knowledge Graph</h2>
                <p className="text-[11px] text-gray-500 mt-0.5">Files and their connections based on shared categories and topics</p>
              </div>
              <button onClick={() => setGraphOpen(false)} className="w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
                <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
            {/* Graph Canvas */}
            <KnowledgeGraph files={files} onSelectFile={(id) => { toggleFileSelect(id); setGraphOpen(false); setChatOpen(true); }} />
            <p className="text-[9px] text-gray-600 text-center py-3">Click a node to select that file for chat · Drag to explore · Size = file size</p>
          </div>
        </div>
      )}

      {/* ══════════════════ ALERTS PANEL ══════════════════ */}
      {alertsOpen && (
        <div className="fixed inset-0 z-40" onClick={() => setAlertsOpen(false)}>
          <div className="absolute top-16 right-4 w-80 bg-[#0D1117] border border-white/10 rounded-2xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
              <div className="flex items-center gap-2">
                <span>🔔</span>
                <span className="text-sm font-bold">Smart Alerts</span>
              </div>
              <button onClick={() => setAlertsOpen(false)} className="text-gray-500 hover:text-gray-300">
                <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div className="max-h-96 overflow-y-auto custom-scrollbar">
              {alerts.length === 0 ? (
                <div className="py-10 text-center text-gray-600 text-sm">
                  <p className="text-2xl mb-2">✅</p>
                  <p>No alerts · Your documents look good!</p>
                </div>
              ) : (
                alerts.map(alert => (
                  <div key={alert.id} className={`px-4 py-3 border-b border-white/5 transition-all ${!alert.is_read ? 'bg-amber-500/5' : ''}`}>
                    <div className="flex items-start gap-2">
                      <span className="text-base mt-0.5">
                        {alert.priority === 'critical' ? '🚨' : alert.priority === 'high' ? '⚠️' : alert.type === 'insight' ? '💡' : '📌'}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-gray-200">{alert.title}</p>
                        <p className="text-[11px] text-gray-400 mt-0.5 leading-relaxed">{alert.message}</p>
                        {alert.due_date && (
                          <p className="text-[10px] text-amber-400 mt-1">📅 {new Date(alert.due_date).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' })}</p>
                        )}
                        <p className="text-[9px] text-gray-600 mt-1">{alert.file_id ? files.find(f=>f.id===alert.file_id)?.name : 'General'}</p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="px-4 py-2 border-t border-white/5 text-[9px] text-gray-600 text-center">
              AI scans your files for important dates and action items
            </div>
          </div>
        </div>
      )}
      {/* ══════════════════ FILE OPS CONFIRM DIALOG ══════════════════ */}
      {fileOpsDialog?.show && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 backdrop-blur-sm">
          <div className="bg-[#0D1117] border border-white/10 rounded-3xl w-[520px] max-h-[85vh] flex flex-col overflow-hidden shadow-2xl">

            {/* Header */}
            <div className="flex items-center gap-3 px-6 py-5 border-b border-white/5">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl
                ${fileOpsDialog.operation === 'delete' ? 'bg-red-500/15 border border-red-500/25' : 'bg-blue-500/15 border border-blue-500/25'}`}>
                {fileOpsDialog.operation === 'archive' ? '📦'
                  : fileOpsDialog.operation === 'delete'  ? '🗑️'
                  : fileOpsDialog.operation === 'restore' ? '♻️'
                  : fileOpsDialog.operation === 'rename'  ? '✏️'
                  : '📂'}
              </div>
              <div>
                <h3 className="text-sm font-bold text-gray-100 capitalize">{fileOpsDialog.operation} Files</h3>
                <p className="text-[11px] text-gray-500 mt-0.5">{fileOpsDialog.summary}</p>
              </div>
            </div>

            {/* Explanation */}
            {fileOpsDialog.explanation && (
              <div className="px-6 py-3 border-b border-white/5 bg-white/2">
                <p className="text-[11px] text-gray-400 leading-relaxed">💡 {fileOpsDialog.explanation}</p>
              </div>
            )}

            {/* File list */}
            <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-4">
              <p className="text-[9px] text-gray-600 uppercase tracking-wider mb-3">
                {fileOpsDialog.files.length} file{fileOpsDialog.files.length > 1 ? 's' : ''} will be affected
              </p>
              <div className="space-y-2">
                {fileOpsDialog.files.map(f => {
                  const meta = getCategoryMeta(f.category);
                  return (
                    <div key={f.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/3 border border-white/5">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${meta.bg} ${meta.color} border ${meta.border} flex-shrink-0`}>
                        {meta.icon}
                      </span>
                      <span className="text-sm text-gray-200 truncate flex-1">{f.name}</span>
                      {fileOpsDialog.operation === 'move' && fileOpsDialog.targetFolder && (
                        <span className="text-[10px] text-gray-500 flex-shrink-0">→ {fileOpsDialog.targetFolder}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Warning for destructive ops */}
            {fileOpsDialog.operation === 'delete' && (
              <div className="mx-6 mb-4 px-4 py-3 rounded-xl bg-red-500/8 border border-red-500/20">
                <p className="text-[11px] text-red-400 leading-relaxed">
                  ⚠️ This permanently deletes the files AND all their AI knowledge (embeddings). This cannot be undone.
                </p>
              </div>
            )}

            {/* Buttons */}
            <div className="flex gap-3 px-6 pb-5">
              <button
                onClick={handleExecuteFileOps}
                disabled={fileOpsDialog.executing}
                className={`flex-1 py-3 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-50 flex items-center justify-center gap-2 ${
                  fileOpsDialog.operation === 'delete'
                    ? 'bg-red-600 hover:bg-red-700'
                    : ''
                }`}
                style={fileOpsDialog.operation !== 'delete'
                  ? { background: 'linear-gradient(135deg,#2563eb,#0891b2)' }
                  : {}}>
                {fileOpsDialog.executing ? (
                  <>
                    <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                    </svg>
                    Working...
                  </>
                ) : (
                  `Yes, ${fileOpsDialog.operation} ${fileOpsDialog.files.length} file${fileOpsDialog.files.length > 1 ? 's' : ''}`
                )}
              </button>
              <button
                onClick={() => setFileOpsDialog(null)}
                disabled={fileOpsDialog.executing}
                className="px-5 py-3 rounded-xl text-sm text-gray-400 hover:text-gray-200 bg-white/5 hover:bg-white/10 transition-all disabled:opacity-50">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════ SEMANTIC DUPES PANEL ══════════════════ */}
      {dupePanel.show && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 backdrop-blur-sm" onClick={() => setDupePanel(p => ({ ...p, show: false }))}>
          <div className="bg-[#0D1117] border border-white/10 rounded-3xl w-[620px] max-h-[85vh] flex flex-col overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-white/5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-orange-500/15 border border-orange-500/25 flex items-center justify-center text-xl">🔍</div>
                <div>
                  <h3 className="text-sm font-bold text-gray-100">Semantic Duplicate Scan</h3>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    {dupePanel.scanning ? 'Scanning your files...' : `${dupePanel.results.length} near-duplicate pair${dupePanel.results.length !== 1 ? 's' : ''} found`}
                  </p>
                </div>
              </div>
              <button onClick={() => setDupePanel(p => ({ ...p, show: false }))}
                className="w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
                <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-4">
              {dupePanel.scanning ? (
                <div className="space-y-3 py-4">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="flex gap-3 p-4 rounded-2xl border border-white/5">
                      <div className="skeleton w-10 h-10 rounded-xl flex-shrink-0"/>
                      <div className="flex-1 space-y-2">
                        <div className="skeleton h-3 w-3/4 rounded"/>
                        <div className="skeleton h-2.5 w-1/2 rounded"/>
                      </div>
                    </div>
                  ))}
                </div>
              ) : dupePanel.results.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="text-5xl mb-4">✨</div>
                  <h4 className="text-base font-semibold text-gray-300 mb-2">No duplicates found!</h4>
                  <p className="text-sm text-gray-500 max-w-xs">All your files have unique content. Your cloud is clean.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-[10px] text-gray-600 mb-4">
                    Files with similar names or content. Review each pair and decide which to keep.
                  </p>
                  {dupePanel.results.map((pair, idx) => {
                    const metaA = getCategoryMeta(pair.fileA.category);
                    const metaB = getCategoryMeta(pair.fileB.category);
                    const pct   = Math.round(pair.similarity * 100);
                    const color = pct >= 90 ? 'text-red-400 bg-red-500/10 border-red-500/20'
                                : pct >= 80 ? 'text-orange-400 bg-orange-500/10 border-orange-500/20'
                                :             'text-yellow-400 bg-yellow-500/10 border-yellow-500/20';
                    return (
                      <div key={idx} className="p-4 rounded-2xl border border-white/8 bg-white/2 hover:bg-white/3 transition-all">
                        {/* Similarity badge */}
                        <div className="flex items-center justify-between mb-3">
                          <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full border ${color}`}>
                            {pair.label}
                          </span>
                          <span className={`text-[9px] px-2 py-0.5 rounded-full bg-white/5 text-gray-500 border border-white/8`}>
                            {pair.reason === 'both' ? 'Content + Name' : pair.reason === 'semantic' ? 'Content match' : 'Name match'}
                          </span>
                        </div>
                        {/* File A */}
                        <div className="flex items-center justify-between gap-3 mb-2">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className="text-lg flex-shrink-0">{getFileIcon(pair.fileA.category, pair.fileA.name)}</span>
                            <div className="min-w-0">
                              <p className="text-xs text-gray-200 font-medium truncate">{pair.fileA.name}</p>
                              <p className="text-[9px] text-gray-500">{metaA.icon} {pair.fileA.category} · {formatBytes(pair.fileA.size)}</p>
                            </div>
                          </div>
                          <button
                            onClick={() => { setFileOpsDialog({ show: true, executing: false, operation: 'delete', fileIds: [pair.fileA.id], files: [{ id: pair.fileA.id, name: pair.fileA.name, category: pair.fileA.category }], summary: `Delete "${pair.fileA.name}"`, explanation: 'Removing the older/duplicate file.' }); }}
                            className="flex-shrink-0 text-[10px] px-2.5 py-1 rounded-lg text-red-400 bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 transition-all">
                            Delete
                          </button>
                        </div>
                        {/* Divider */}
                        <div className="flex items-center gap-2 my-2">
                          <div className="flex-1 h-px bg-white/5"/>
                          <span className="text-[9px] text-gray-600">vs</span>
                          <div className="flex-1 h-px bg-white/5"/>
                        </div>
                        {/* File B */}
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span className="text-lg flex-shrink-0">{getFileIcon(pair.fileB.category, pair.fileB.name)}</span>
                            <div className="min-w-0">
                              <p className="text-xs text-gray-200 font-medium truncate">{pair.fileB.name}</p>
                              <p className="text-[9px] text-gray-500">{metaB.icon} {pair.fileB.category} · {formatBytes(pair.fileB.size)}</p>
                            </div>
                          </div>
                          <button
                            onClick={() => { setFileOpsDialog({ show: true, executing: false, operation: 'delete', fileIds: [pair.fileB.id], files: [{ id: pair.fileB.id, name: pair.fileB.name, category: pair.fileB.category }], summary: `Delete "${pair.fileB.name}"`, explanation: 'Removing the duplicate file.' }); }}
                            className="flex-shrink-0 text-[10px] px-2.5 py-1 rounded-lg text-red-400 bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 transition-all">
                            Delete
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-white/5 flex items-center justify-between">
              <p className="text-[9px] text-gray-600">Similarity threshold: 82% · SHA-256 exact dupes blocked at upload</p>
              <button onClick={() => setDupePanel(p => ({ ...p, show: false }))}
                className="px-5 py-2 rounded-xl text-sm text-gray-400 hover:text-gray-200 bg-white/5 hover:bg-white/10 transition-all">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════ PERSONAL TIMELINE MODAL ══════════════════ */}
      {timelineOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 backdrop-blur-sm" onClick={() => setTimelineOpen(false)}>
          <div className="bg-[#0D1117] border border-white/10 rounded-3xl w-[640px] max-h-[85vh] flex flex-col overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-5 border-b border-white/5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-violet-500/15 border border-violet-500/25 flex items-center justify-center text-xl">📅</div>
                <div>
                  <h3 className="text-sm font-bold text-gray-100">Personal Timeline</h3>
                  <p className="text-[11px] text-gray-500 mt-0.5">Your life in documents</p>
                </div>
              </div>
              <button onClick={() => setTimelineOpen(false)} className="w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
                <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-4">
              {timelineLoading ? (
                <div className="space-y-4 py-4">
                  {[...Array(5)].map((_,i) => <div key={i} className="flex gap-4"><div className="skeleton w-12 h-12 rounded-xl flex-shrink-0"/><div className="flex-1 space-y-2"><div className="skeleton h-3 w-1/2 rounded"/><div className="skeleton h-2.5 w-3/4 rounded"/></div></div>)}
                </div>
              ) : !timelineData || timelineData.total === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="text-4xl mb-4">📄</div>
                  <p className="text-gray-300 font-medium mb-2">No dated documents found yet</p>
                  <p className="text-sm text-gray-500">Upload certificates, tickets, salary slips, or medical records to build your timeline</p>
                </div>
              ) : (
                <div className="space-y-8">
                  {timelineData.years?.map((year: number) => (
                    <div key={year}>
                      <div className="flex items-center gap-3 mb-4">
                        <div className="text-lg font-bold text-violet-400">{year}</div>
                        <div className="flex-1 h-px bg-violet-500/20"/>
                        <span className="text-[10px] text-gray-600">{timelineData.byYear[year]?.length} events</span>
                      </div>
                      <div className="space-y-3 ml-4 border-l border-white/8 pl-6">
                        {timelineData.byYear[year]?.map((event: any, idx: number) => {
                          const typeIcons: Record<string,string> = { travel:'✈️', achievement:'🏆', health:'❤️', payroll:'💰', financial:'🏦', tax:'🧾', identity:'🪪', education:'🎓', career:'💼', purchase:'🛍️', personal:'👤', document:'📄' };
                          return (
                            <div key={idx} className="relative flex gap-4 group">
                              <div className="absolute -left-8 top-2 w-4 h-4 rounded-full bg-[#0D1117] border-2 border-violet-500/40 flex-shrink-0"/>
                              <div className="flex-1 bg-white/3 border border-white/5 rounded-xl p-3 hover:bg-white/5 transition-all cursor-pointer"
                                onClick={() => { setTimelineOpen(false); const f = files.find(fi => fi.id === event.fileId); if(f){ openPreview(f); }}}>
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="text-base">{typeIcons[event.type] || '📄'}</span>
                                  <span className="text-xs font-semibold text-gray-200 truncate flex-1">{event.fileName}</span>
                                  <span className="text-[9px] text-gray-600 flex-shrink-0">{new Date(event.date).toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</span>
                                </div>
                                <p className="text-[11px] text-gray-500 leading-relaxed truncate">{event.snippet}</p>
                                <span className={`text-[9px] mt-1.5 inline-block px-2 py-0.5 rounded-full font-bold ${getCategoryMeta(event.category).bg} ${getCategoryMeta(event.category).color}`}>
                                  {getCategoryMeta(event.category).icon} {event.category}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="px-6 py-3 border-t border-white/5 text-[9px] text-gray-600 text-center">
              Dates extracted from {files.length} indexed files · Click any event to preview the file
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════ PRIVACY SENSITIVITY PANEL ══════════════════ */}
      {sensitivityOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 backdrop-blur-sm" onClick={() => setSensitivityOpen(false)}>
          <div className="bg-[#0D1117] border border-white/10 rounded-3xl w-[620px] max-h-[85vh] flex flex-col overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-5 border-b border-white/5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-red-500/15 border border-red-500/25 flex items-center justify-center text-xl">🔒</div>
                <div>
                  <h3 className="text-sm font-bold text-gray-100">Privacy Sensitivity Scan</h3>
                  <p className="text-[11px] text-gray-500 mt-0.5">PII detection across your cloud</p>
                </div>
              </div>
              <button onClick={() => setSensitivityOpen(false)} className="w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
                <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-4">
              {sensitivityLoading ? (
                <div className="space-y-3 py-4">{[...Array(5)].map((_,i)=><div key={i} className="flex gap-3 p-3 rounded-xl bg-white/3"><div className="skeleton w-10 h-10 rounded-xl flex-shrink-0"/><div className="flex-1 space-y-2"><div className="skeleton h-3 w-1/2 rounded"/><div className="skeleton h-2 w-3/4 rounded"/></div></div>)}</div>
              ) : sensitivityData ? (
                <>
                  <div className="grid grid-cols-3 gap-3 mb-5">
                    {[{level:'HIGH',color:'text-red-400',bg:'bg-red-500/10',border:'border-red-500/20',icon:'🚨'},
                      {level:'MEDIUM',color:'text-amber-400',bg:'bg-amber-500/10',border:'border-amber-500/20',icon:'⚠️'},
                      {level:'LOW',color:'text-emerald-400',bg:'bg-emerald-500/10',border:'border-emerald-500/20',icon:'✅'}].map(({level,color,bg,border,icon})=>(
                      <div key={level} className={`${bg} border ${border} rounded-xl p-3 text-center`}>
                        <div className="text-2xl mb-1">{icon}</div>
                        <div className={`text-xl font-bold ${color}`}>{sensitivityData.summary?.[level.toLowerCase()] ?? 0}</div>
                        <div className={`text-[10px] ${color} uppercase font-bold tracking-wider`}>{level}</div>
                      </div>
                    ))}
                  </div>
                  <p className="text-[9px] text-gray-600 mb-3 uppercase tracking-wider">Scanned {sensitivityData.total} files · PII types detected</p>
                  <div className="space-y-2">
                    {sensitivityData.results?.filter((r:any)=>r.sensitivity!=='LOW').map((r:any,i:number)=>{
                      const colors: Record<string,string> = {HIGH:'text-red-400 bg-red-500/10 border-red-500/20', MEDIUM:'text-amber-400 bg-amber-500/10 border-amber-500/20'};
                      return (
                        <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-white/3 border border-white/5 hover:bg-white/5 transition-all">
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border flex-shrink-0 ${colors[r.sensitivity]}`}>{r.sensitivity}</span>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-gray-200 truncate">{r.fileName}</p>
                            <p className="text-[10px] text-gray-500 mt-0.5">
                              {r.piiTypes.length > 0 ? r.piiTypes.join(' · ') : 'General PII detected'}
                            </p>
                          </div>
                          <span className={`text-[9px] px-2 py-0.5 rounded-full font-bold ${getCategoryMeta(r.category).bg} ${getCategoryMeta(r.category).color}`}>
                            {getCategoryMeta(r.category).icon}
                          </span>
                        </div>
                      );
                    })}
                    {sensitivityData.results?.every((r:any)=>r.sensitivity==='LOW') && (
                      <div className="flex flex-col items-center py-10 text-center">
                        <div className="text-4xl mb-3">✅</div>
                        <p className="text-gray-300 font-medium">No sensitive PII detected</p>
                        <p className="text-sm text-gray-500 mt-1">Your cloud looks clean!</p>
                      </div>
                    )}
                  </div>
                </>
              ) : null}
            </div>
            <div className="px-6 py-3 border-t border-white/5 text-[9px] text-gray-600 text-center">
              Scans for Aadhaar · PAN · Bank account · Phone · Passport · GSTIN · Email
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════ DELETE CONFIRMATION MODAL ══════════════════ */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 backdrop-blur-sm">
          <div className="bg-[#0D1117] border border-white/10 rounded-3xl w-[420px] overflow-hidden shadow-2xl"
               style={{ animation: 'cardIn 0.2s cubic-bezier(0.34,1.56,0.64,1) both' }}>

            {/* Icon + title */}
            <div className="flex flex-col items-center px-8 pt-8 pb-5 text-center">
              <div className="w-14 h-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mb-4">
                <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" className="text-red-400">
                  <polyline points="3 6 5 6 21 6"/>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </div>
              <h3 className="text-base font-bold text-gray-100 mb-1">Delete this file?</h3>
              <p className="text-sm text-gray-400 leading-relaxed break-all">
                <span className="text-gray-200 font-medium">"{deleteConfirm.fileName}"</span>
              </p>
            </div>

            {/* Warning detail */}
            <div className="mx-6 mb-6 px-4 py-3 rounded-xl bg-red-500/6 border border-red-500/15">
              <p className="text-[11px] text-red-400 leading-relaxed text-center">
                This permanently deletes the file, all its AI knowledge, embeddings, and the original from cloud storage. This cannot be undone.
              </p>
            </div>

            {/* Action buttons */}
            <div className="flex gap-3 px-6 pb-6">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 py-3 rounded-xl text-sm font-semibold text-gray-300 bg-white/5 hover:bg-white/10 border border-white/8 hover:border-white/15 transition-all">
                Cancel
              </button>
              <button
                onClick={executeDelete}
                className="flex-1 py-3 rounded-xl text-sm font-bold text-white bg-red-600 hover:bg-red-700 transition-all flex items-center justify-center gap-2">
                <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <polyline points="3 6 5 6 21 6"/>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
                </svg>
                Yes, delete permanently
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&display=swap');

        /* Global smoothness */
        *{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;scroll-behavior:smooth}

        /* Ambient background depth */
        body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;
          background:radial-gradient(ellipse 80% 50% at 20% -10%,rgba(37,99,235,0.07) 0%,transparent 60%),
                     radial-gradient(ellipse 60% 40% at 80% 100%,rgba(8,145,178,0.05) 0%,transparent 55%)}

        /* File card animations */
        .card-enter{animation:cardIn 0.3s cubic-bezier(0.34,1.56,0.64,1) both}
        @keyframes cardIn{from{opacity:0;transform:translateY(10px) scale(0.97)}to{opacity:1;transform:none}}

        /* Card hover lift */
        .file-card{transition:transform 200ms cubic-bezier(0.34,1.56,0.64,1),box-shadow 200ms ease!important}
        .file-card:hover{transform:translateY(-3px)!important;box-shadow:0 12px 40px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.06)!important}
        .file-card:active{transform:scale(0.97)!important;transition-duration:80ms!important}

        /* Button press */
        button:not(:disabled):active{transform:scale(0.96);transition-duration:80ms}
        button:focus-visible{outline:2px solid rgba(59,130,246,0.6);outline-offset:2px;border-radius:8px}

        /* Search focus ring */
        .search-ring:focus-within{border-color:rgba(59,130,246,0.5)!important;box-shadow:0 0 0 3px rgba(59,130,246,0.12)!important}

        /* Enable text selection in chat messages */
        .md-content,.md-p,.md-h1,.md-h2,.md-h3,.md-bold,.md-em,.md-li,.md-oli{
          user-select:text;-webkit-user-select:text;cursor:text}

        /* Markdown styles */
        .md-content{line-height:1.7}
        .md-p{margin:0 0 0.6em 0}
        .md-h1{font-size:1.1em;font-weight:700;margin:0.8em 0 0.4em;color:#e2e8f0}
        .md-h2{font-size:1em;font-weight:700;margin:0.7em 0 0.3em;color:#e2e8f0}
        .md-h3{font-size:0.95em;font-weight:600;margin:0.6em 0 0.3em;color:#cbd5e1}
        .md-bold{font-weight:700;color:#f1f5f9}
        .md-em{font-style:italic;color:#cbd5e1}
        .md-pre{background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px 14px;margin:0.6em 0;overflow-x:auto}
        .md-code{font-family:monospace;font-size:0.82em;color:#7dd3fc;white-space:pre}
        .md-inline{background:rgba(59,130,246,0.15);color:#93c5fd;border-radius:4px;padding:1px 5px;font-family:monospace;font-size:0.82em}
        .md-ul,.md-ol{margin:0.4em 0 0.6em 1.2em;padding:0}
        .md-li,.md-oli{margin:0.2em 0;line-height:1.6;list-style-type:disc}
        .md-oli{list-style-type:decimal}
        .md-hr{border:none;border-top:1px solid rgba(255,255,255,0.1);margin:0.8em 0}
        .md-source{color:#a78bfa;font-size:0.85em;margin:0.3em 0}
        .md-reason{color:#67e8f9;font-size:0.85em;margin:0.3em 0}
        .md-answer{color:#6ee7b7;font-size:0.85em;margin:0.3em 0}

        /* Skeleton loader */
        @keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
        .skeleton{background:linear-gradient(90deg,rgba(255,255,255,0.02) 25%,rgba(255,255,255,0.06) 50%,rgba(255,255,255,0.02) 75%);background-size:200% 100%;animation:shimmer 2s ease-in-out infinite}

        /* Toast animate-in */
        @keyframes slide-in-from-bottom-2{from{transform:translateY(14px);opacity:0}to{transform:none;opacity:1}}
        .animate-in{animation:slide-in-from-bottom-2 0.3s cubic-bezier(0.34,1.56,0.64,1)}

        /* Scrollbar */
        .custom-scrollbar{scroll-behavior:smooth}
        .custom-scrollbar::-webkit-scrollbar{width:4px}
        .custom-scrollbar::-webkit-scrollbar-thumb{background:linear-gradient(180deg,rgba(59,130,246,0.35),rgba(6,182,212,0.25));border-radius:99px}
        .custom-scrollbar::-webkit-scrollbar-thumb:hover{background:linear-gradient(180deg,rgba(59,130,246,0.6),rgba(6,182,212,0.5))}
        .custom-scrollbar::-webkit-scrollbar-track{background:transparent}

        /* Tailwind shorthands */
        .bg-white\/2{background-color:rgba(255,255,255,0.02)}
        .bg-white\/3{background-color:rgba(255,255,255,0.03)}
        .bg-white\/8{background-color:rgba(255,255,255,0.08)}
        .bg-blue-500\/8{background-color:rgba(59,130,246,0.08)}
        .border-white\/6{border-color:rgba(255,255,255,0.06)}
        .border-white\/8{border-color:rgba(255,255,255,0.08)}
        .border-white\/12{border-color:rgba(255,255,255,0.12)}
        .border-white\/15{border-color:rgba(255,255,255,0.15)}

        /* Brand gradient animation */
        @keyframes gradientShift{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
        .brand-gradient{background:linear-gradient(270deg,#3b82f6,#06b6d4,#8b5cf6,#3b82f6);background-size:400% 400%;-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;animation:gradientShift 6s ease infinite}

        /* Chat slide-in */
        @keyframes chatSlideIn{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}
        .chat-slide-in{animation:chatSlideIn 0.25s cubic-bezier(0.34,1.56,0.64,1);display:flex;flex-direction:column;flex:1;min-height:0}

        /* Page entrance */
        main{animation:pageIn 0.35s ease both}
        @keyframes pageIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

        /* Mobile touch improvements */
        @media(max-width:767px){
          button{min-height:40px;min-width:40px}
          .file-card{border-radius:16px}
          .file-card:hover{transform:none!important}
          .file-card:active{transform:scale(0.97)!important}
        }
      `}</style>
    </div>
    </>
  );
}

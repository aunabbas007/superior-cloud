'use client';
// PATH: components/SplashScreen.tsx
//
// Brand: A≡B
// Logo:  Sync arrows — left curved arrow pointing DOWN, right pointing UP
//        Each arrow is a cubic bezier with mathematically correct tangents
//
// Animation sequence (runs in 2.5s, dashboard loads behind — zero delay):
//   0.00s  Container + icon card scale in
//   0.15s  Blue left arc draws itself (stroke-dashoffset via getTotalLength)
//   0.55s  Blue arrowhead snaps in pointing DOWN
//   0.60s  Cyan right arc draws itself
//   1.00s  Cyan arrowhead snaps in pointing UP
//   1.05s  "A≡B" slides up + gradient fades in
//   1.45s  "welcomes you" blurs from 16px → 0px, letter-spacing collapses
//   2.00s  All elements fade out together
//   2.55s  Component unmounts

import { useEffect, useRef, useState } from 'react';

interface Props { onComplete: () => void; }

export default function SplashScreen({ onComplete }: Props) {
  const [exit, setExit] = useState(false);

  // Refs to SVG path elements for getTotalLength()
  const leftArcRef   = useRef<SVGPathElement>(null);
  const rightArcRef  = useRef<SVGPathElement>(null);

  useEffect(() => {
    // Set exact path lengths so draw animation is pixel-perfect
    const setLen = (el: SVGPathElement | null, delay: string) => {
      if (!el) return;
      const len = el.getTotalLength();
      el.style.strokeDasharray  = `${len}`;
      el.style.strokeDashoffset = `${len}`;
      el.style.animation = `aeqbDraw 0.7s ease-out ${delay} forwards`;
    };
    setLen(leftArcRef.current,  '0.15s');
    setLen(rightArcRef.current, '0.60s');

    const t1 = setTimeout(() => setExit(true), 2000);
    const t2 = setTimeout(() => onComplete(),  2550);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [onComplete]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: '#080B12',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 30,
      opacity: exit ? 0 : 1,
      transition: exit ? 'opacity 0.55s ease-out' : 'none',
      pointerEvents: exit ? 'none' : 'auto',
    }}>

      {/* ── Sync icon ──────────────────────────────────────────────── */}
      <div style={{ animation: 'aeqbPop 0.45s cubic-bezier(0.34,1.56,0.64,1) both' }}>
        <svg
          width="112"
          height="112"
          viewBox="0 0 512 512"
          xmlns="http://www.w3.org/2000/svg"
          style={{ overflow: 'visible', display: 'block' }}
        >
          <defs>
            <linearGradient id="spbg" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#0c1628"/>
              <stop offset="100%" stopColor="#0f2040"/>
            </linearGradient>
          </defs>

          {/* Background card */}
          <rect width="512" height="512" rx="108" fill="url(#spbg)"/>

          {/*
            LEFT ARC — BLUE
            Bezier: M 280,82 C 50,82 248,380 248,435
            ▸ Swings to left (peak x≈178), arrives at bottom going DOWN ✓
            getTotalLength() sets exact dasharray for smooth draw animation
          */}
          <path
            ref={leftArcRef}
            d="M 280,82 C 50,82 248,380 248,435"
            fill="none"
            stroke="#3b82f6"
            stroke-width="28"
            strokeLinecap="round"
          />
          {/* Blue arrowhead — V pointing DOWN, tip at (248,444) */}
          <polyline
            points="216,412  248,444  280,412"
            fill="none"
            stroke="#3b82f6"
            stroke-width="28"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ animation: 'aeqbArrow 0.25s ease-out 0.55s both' }}
          />

          {/*
            RIGHT ARC — CYAN
            Bezier: M 264,435 C 460,435 264,134 264,77
            ▸ Swings to right (peak x≈338), arrives at top going UP ✓
          */}
          <path
            ref={rightArcRef}
            d="M 264,435 C 460,435 264,134 264,77"
            fill="none"
            stroke="#06b6d4"
            stroke-width="28"
            strokeLinecap="round"
          />
          {/* Cyan arrowhead — V pointing UP, tip at (264,68) */}
          <polyline
            points="232,100  264,68  296,100"
            fill="none"
            stroke="#06b6d4"
            stroke-width="28"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ animation: 'aeqbArrow 0.25s ease-out 1.00s both' }}
          />
        </svg>
      </div>

      {/* ── A≡B wordmark ───────────────────────────────────────────── */}
      <div style={{ animation: 'aeqbUp 0.5s ease-out 1.05s both' }}>
        <p style={{
          fontFamily: "'DM Sans','Inter','Helvetica Neue',Arial,sans-serif",
          fontSize:   58,
          fontWeight: 600,
          letterSpacing: '-1px',
          lineHeight: 1,
          margin: 0,
          background: 'linear-gradient(135deg,#3b82f6 0%,#06b6d4 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
        }}>A≡B</p>
      </div>

      {/* ── Tagline — blurs to clarity ─────────────────────────────── */}
      <p style={{
        fontFamily: "'DM Sans','Inter',sans-serif",
        fontSize: 13,
        color: 'rgba(148,163,184,0.85)',
        letterSpacing: '0.2em',
        textTransform: 'uppercase',
        margin: 0,
        animation: 'aeqbBlur 0.9s ease-out 1.45s both',
      }}>
        welcomes you
      </p>

      {/* ── Keyframes ──────────────────────────────────────────────── */}
      <style>{`
        @keyframes aeqbPop {
          from { opacity:0; transform:scale(0.68) }
          to   { opacity:1; transform:scale(1)    }
        }
        @keyframes aeqbDraw {
          to { stroke-dashoffset: 0 }
        }
        @keyframes aeqbArrow {
          from { opacity:0; transform:scale(0.5) }
          to   { opacity:1; transform:scale(1)   }
        }
        @keyframes aeqbUp {
          from { opacity:0; transform:translateY(18px) }
          to   { opacity:1; transform:translateY(0)    }
        }
        @keyframes aeqbBlur {
          from { opacity:0; filter:blur(18px); letter-spacing:0.55em }
          to   { opacity:1; filter:blur(0);    letter-spacing:0.2em  }
        }
      `}</style>
    </div>
  );
}

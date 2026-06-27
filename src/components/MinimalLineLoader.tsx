import React from 'react';

interface MinimalLineLoaderProps {
  text?: string;
}

export const MinimalLineLoader: React.FC<MinimalLineLoaderProps> = ({ text = "AUTHORIZING" }) => {
  return (
    <div className="absolute inset-0 z-[2000] flex flex-col items-center justify-center bg-gunmetal-900 bg-opacity-95 backdrop-blur-md">
      
      {/* Quantum Orbital Container */}
      <div className="relative w-40 h-40 flex items-center justify-center" style={{ perspective: '1000px', transformStyle: 'preserve-3d' }}>
        
        {/* Core Nucleus (Mesh Globe) */}
        <div className="absolute z-10 w-8 h-8 animate-spin-slower flex items-center justify-center drop-shadow-[0_0_15px_rgba(34,211,238,0.8)]">
          <svg viewBox="0 0 100 100" fill="none" stroke="currentColor" className="text-cyan-500 w-full h-full opacity-80" strokeWidth="2">
            <circle cx="50" cy="50" r="48" />
            <ellipse cx="50" cy="50" rx="20" ry="48" />
            <ellipse cx="50" cy="50" rx="48" ry="15" />
            <line x1="50" y1="2" x2="50" y2="98" />
            <line x1="2" y1="50" x2="98" y2="50" />
          </svg>
          <div className="absolute w-2 h-2 bg-cyan-300 rounded-full shadow-[0_0_20px_rgba(34,211,238,1)] animate-pulse" />
        </div>

        {/* Orbital Ring 1 (Cyan) */}
        <div className="absolute w-32 h-32" style={{ transform: 'rotateX(70deg) rotateY(0deg)', transformStyle: 'preserve-3d' }}>
          <div className="relative w-full h-full rounded-full border-2 border-cyan-500/30 animate-spin-fast">
            <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 bg-cyan-300 rounded-full shadow-[0_0_12px_currentColor] z-10" />
            <div className="absolute inset-0 rounded-full" style={{ background: 'conic-gradient(from 0deg, transparent 70%, rgba(34,211,238,0.8) 100%)', filter: 'blur(3px)', transform: 'rotate(-45deg)' }} />
          </div>
        </div>

        {/* Orbital Ring 2 (Slate) */}
        <div className="absolute w-32 h-32" style={{ transform: 'rotateX(70deg) rotateY(60deg)', transformStyle: 'preserve-3d' }}>
          <div className="relative w-full h-full rounded-full border-2 border-slate-500/30 animate-spin-reverse">
            <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 bg-slate-300 rounded-full shadow-[0_0_12px_currentColor] z-10" />
            <div className="absolute inset-0 rounded-full" style={{ background: 'conic-gradient(from 0deg, transparent 70%, rgba(148,163,184,0.6) 100%)', filter: 'blur(3px)', transform: 'rotate(135deg)' }} />
          </div>
        </div>

        {/* Orbital Ring 3 (Slate) */}
        <div className="absolute w-32 h-32" style={{ transform: 'rotateX(70deg) rotateY(120deg)', transformStyle: 'preserve-3d' }}>
          <div className="relative w-full h-full rounded-full border-2 border-slate-500/30 animate-spin-slow">
            <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 bg-slate-300 rounded-full shadow-[0_0_12px_currentColor] z-10" />
            <div className="absolute inset-0 rounded-full" style={{ background: 'conic-gradient(from 0deg, transparent 70%, rgba(148,163,184,0.6) 100%)', filter: 'blur(3px)', transform: 'rotate(-45deg)' }} />
          </div>
        </div>

      </div>

      {/* Subtle Text */}
      <div className="mt-8 text-cyan-400 font-mono text-[10px] tracking-[0.5em] uppercase opacity-90 animate-pulse drop-shadow-[0_0_8px_rgba(34,211,238,0.6)]">
        {text}
      </div>
    </div>
  );
};

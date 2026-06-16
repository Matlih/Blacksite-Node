import React, { useState, useEffect } from 'react';

interface MinimalLineLoaderProps {
  text?: string;
}

export const MinimalLineLoader: React.FC<MinimalLineLoaderProps> = ({ text = "AUTHORIZING" }) => {
  const [chars, setChars] = useState("0101010101010101010101010101010101010101010101010101010101010101");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const charset = "0123456789ABCDEF";
    let time = 0;
    
    // Indeterminate scrambler with a one-time expanding line
    const interval = setInterval(() => {
      time += 0.05; 
      
      // Expand outwards starting from 25%, cap at 100
      let sweepPos = 25 + (time * 20); 
      if (sweepPos > 100) sweepPos = 100;
      setProgress(sweepPos);

      let newStr = "";
      for (let i = 0; i < 64; i++) {
        // The characters vanish as the solid line expands from the center
        const centerDistance = Math.abs(i - 32);
        
        if (centerDistance < ((sweepPos / 100) * 32)) {
          newStr += "\u00A0"; 
        } else {
          newStr += charset[Math.floor(Math.random() * charset.length)];
        }
      }
      setChars(newStr);
    }, 30);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-gunmetal-900 bg-opacity-95 backdrop-blur-md">
      
      {/* The Central Area */}
      <div className="relative w-full max-w-xl h-10 flex flex-col items-center justify-center">
        
        {/* The Scrambled Text Layer */}
        <div className="absolute font-mono text-xs text-ops-500 tracking-[0.3em] w-full text-center whitespace-nowrap opacity-60">
          {chars}
        </div>
        
        {/* The Solid Glowing Line that Expands from Center */}
        <div 
          className="absolute h-[2px] bg-blue-active shadow-[0_0_12px_rgba(56,189,248,1)]"
          style={{ width: `${progress}%` }}
        />

      </div>

      {/* Subtle Text */}
      <div className="mt-10 text-slate-label font-mono text-xs tracking-[0.5em] uppercase opacity-80 animate-pulse">
        {text}
      </div>
      
    </div>
  );
};

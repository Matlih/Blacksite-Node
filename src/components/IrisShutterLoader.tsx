import React from 'react';

export const IrisShutterLoader: React.FC = () => {
  return (
    <div className="absolute inset-0 z-[100] flex items-center justify-center overflow-hidden pointer-events-none bg-transparent">
      {/* 6 blades of the iris */}
      {[...Array(6)].map((_, i) => (
        <div 
          key={i} 
          className="absolute inset-0 flex items-center justify-center origin-center"
          style={{ transform: `rotate(${i * 60}deg)` }}
        >
          <div 
            className="absolute w-[200vw] h-[200vh] bg-gunmetal-900 border-t-[3px] border-blue-active shadow-[0_0_30px_rgba(56,189,248,0.5)] origin-bottom -translate-y-full rotate-[20deg] animate-blade"
          />
        </div>
      ))}
      
      {/* Central Logo (Pupil) that fades in at the end */}
      <div className="absolute z-10 opacity-0 animate-fade-in-late flex items-center justify-center">
        <img src="/app_logo.png" alt="Blacksite Node" className="w-20 h-20 object-contain drop-shadow-[0_0_20px_rgba(56,189,248,0.7)]" />
      </div>

    </div>
  );
};

import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

interface DropdownProps {
  value: string;
  onChange: (value: string) => void;
  options: { label: string; value: string }[];
  placeholder?: string;
  className?: string;
}

export const Dropdown: React.FC<DropdownProps> = ({ value, onChange, options, placeholder = "Select...", className = "" }) => {
  const [isOpen, setIsOpen] = useState(false);

  const selectedOption = options.find(o => o.value === value);

  return (
    <div className={`relative flex items-center cursor-pointer ${className}`} onClick={() => setIsOpen(!isOpen)}>
      <span className="text-xs mr-1 truncate">{selectedOption ? selectedOption.label : placeholder}</span>
      <ChevronDown size={12} className="shrink-0" />
      
      {isOpen && (
        <>
          <div className="fixed inset-0 z-40 cursor-default" onClick={(e) => { e.stopPropagation(); setIsOpen(false); }}></div>
          <div className="absolute top-full left-0 mt-1 z-50 bg-gunmetal-800 border border-ops-700 rounded shadow-xl py-1 min-w-[120px] max-h-48 overflow-y-auto custom-scrollbar cursor-default" onClick={(e) => e.stopPropagation()}>
            {options.map(o => (
              <button 
                key={o.value}
                className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-zinc-700 hover:text-white truncate"
                onClick={() => { onChange(o.value); setIsOpen(false); }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

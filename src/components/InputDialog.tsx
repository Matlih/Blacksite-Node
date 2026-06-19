import React, { useState, useEffect } from 'react';

interface InputDialogProps {
  isOpen: boolean;
  title: string;
  initialValue?: string;
  onConfirm: (value: string) => void;
  onClose: () => void;
}

export const InputDialog: React.FC<InputDialogProps> = ({ isOpen, title, initialValue = "", onConfirm, onClose }) => {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (isOpen) {
      setValue(initialValue);
    }
  }, [isOpen, initialValue]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[999] flex items-center justify-center p-4">
      <div className="bg-gunmetal-900 border border-ops-600 rounded-lg p-6 w-full max-w-sm shadow-2xl animate-in fade-in zoom-in-95 duration-200">
        <h3 className="text-slate-200 font-bold mb-4">{title}</h3>
        <input 
          type="text" 
          autoFocus
          className="input-ops w-full mb-6" 
          value={value} 
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onConfirm(value);
              onClose();
            } else if (e.key === 'Escape') {
              onClose();
            }
          }}
        />
        <div className="flex justify-end gap-3">
          <button className="text-slate-400 hover:text-slate-200 text-sm font-bold tracking-widest uppercase px-4" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary py-2 px-6" onClick={() => { onConfirm(value); onClose(); }}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
};

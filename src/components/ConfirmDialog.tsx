import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onClose: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({ isOpen, title, message, onConfirm, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[999] flex items-center justify-center p-4">
      <div className="bg-gunmetal-900 border border-amber-warn/50 rounded-lg p-6 w-full max-w-sm shadow-2xl animate-in fade-in zoom-in-95 duration-200">
        <h3 className="text-amber-warn font-bold mb-2 flex items-center gap-2">
          <AlertTriangle size={18} /> {title}
        </h3>
        <p className="text-slate-300 text-sm mb-6 leading-relaxed">
          {message}
        </p>
        <div className="flex justify-end gap-3">
          <button className="text-slate-400 hover:text-slate-200 text-sm font-bold tracking-widest uppercase px-4" onClick={onClose}>
            Cancel
          </button>
          <button className="bg-amber-warn hover:bg-amber-warn/80 text-black font-bold py-2 px-6 rounded transition-colors uppercase tracking-widest text-xs" onClick={() => { onConfirm(); onClose(); }}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
};

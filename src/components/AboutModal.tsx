import React, { useState } from 'react';
import { X, Copy, Check, Info, AlertTriangle, Trash2, Power, Download } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { InputDialog } from './InputDialog';
import qrImage from '../assets/donation_qr.png';

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
  appVersion: string;
  allowWipe?: boolean;
  onExportRequest?: () => void;
}

export const AboutModal: React.FC<AboutModalProps> = ({ isOpen, onClose, appVersion, allowWipe = false, onExportRequest }) => {
  const [copied, setCopied] = useState(false);
  const [showExportPrompt, setShowExportPrompt] = useState(false);
  const [showWipeAuth, setShowWipeAuth] = useState(false);
  const [showWipeSuccess, setShowWipeSuccess] = useState(false);

  const kofiLink = "ko-fi.com/matlih";

  if (!isOpen) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(kofiLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Failed to copy", e);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
      <div className="bg-gunmetal-900 border border-zinc-800 rounded-lg shadow-2xl w-full max-w-sm flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
        
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-800 bg-gunmetal-800">
          <div className="flex items-center gap-2 text-slate-200 font-bold text-sm">
            <Info size={16} className="text-emerald-500" />
            ABOUT BLACKSITE NODE
          </div>
          <button 
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 flex flex-col items-center space-y-6">
          <div className="text-center space-y-1">
            <img src="/app_logo.png" alt="Blacksite Node" className="h-16 w-auto object-contain mx-auto mb-3 opacity-90" />
            <div className="text-xs text-zinc-500 font-mono">VERSION {appVersion}</div>
            <div className="text-xs text-zinc-600 font-mono mt-1">BUILD DATE: 2026-06-19</div>
            <div className="text-xs text-ops-500 font-mono mt-2 uppercase tracking-widest">
              Developed By: Montazar Matlih (github.com/Matlih)
            </div>
          </div>

          {/* FOSS Tag */}
          <div className="w-full text-center p-3 border border-dashed border-zinc-700 bg-zinc-900/50 rounded">
            <div className="text-xs font-semibold text-emerald-400 uppercase tracking-widest mb-1">100% Free Open Source Software (FOSS)</div>
            <div className="text-xs text-zinc-400">Zero telemetry. Zero clouds.</div>
          </div>


          {/* Donation Section */}
          <div className="w-full space-y-3 flex flex-col items-center pt-2 border-t border-zinc-800/50">
            <div className="text-xs text-zinc-400 uppercase tracking-widest font-semibold">Support the Developer</div>
            
            <div className="bg-white p-2 rounded shadow-inner mb-1">
              <img src={qrImage} alt="Ko-fi QR Code" className="w-32 h-32 object-contain" />
            </div>

            <div className="text-xs font-mono text-zinc-500 tracking-[0.3em] my-1">— OR —</div>

            <div className="flex items-center justify-center bg-zinc-950 border border-zinc-800 pl-3 pr-2 py-1.5 rounded mt-1 w-full max-w-[200px]">
              <div className="text-xs font-mono text-zinc-400 select-all truncate flex-1">
                {kofiLink}
              </div>
              <button
                onClick={handleCopy}
                className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-emerald-400 transition-colors shrink-0 ml-2"
                title="Copy Link"
              >
                {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
              </button>
            </div>
          </div>

          {/* Danger Zone */}
          {allowWipe && (
            <div className="w-full space-y-3 flex flex-col items-center pt-6 border-t border-red-900/30">
              <div className="text-[10px] text-red-critical/70 uppercase tracking-widest font-bold flex items-center gap-1">
                <AlertTriangle size={12} /> DANGER ZONE
              </div>
              <button 
                onClick={() => setShowExportPrompt(true)}
                className="w-full border border-red-critical/30 hover:bg-red-critical/10 text-red-critical/80 hover:text-red-critical text-xs uppercase tracking-widest font-bold py-2 rounded transition-all"
              >
                Wipe Vault
              </button>
            </div>
          )}

        </div>
      </div>

      {/* Export Prompt Dialog */}
      {showExportPrompt && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[1010] flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-gunmetal-900 border border-amber-warn/50 rounded-lg p-6 w-full max-w-sm shadow-[0_0_30px_rgba(245,158,11,0.2)]">
            <h3 className="text-amber-warn font-bold mb-2 flex items-center gap-2">
              <AlertTriangle size={18} /> WAIT!
            </h3>
            <p className="text-slate-300 text-sm mb-6 leading-relaxed">
              Do you want to export your passwords and notes before completely destroying this vault?
            </p>
            <div className="flex flex-col gap-3">
              <button 
                className="btn-primary flex items-center justify-center gap-2" 
                onClick={() => {
                  if (onExportRequest) onExportRequest();
                }}
              >
                <Download size={14} /> EXPORT DATA FIRST
              </button>
              <button 
                className="text-red-critical border border-red-critical/30 hover:bg-red-critical/10 py-2 rounded text-xs tracking-widest font-bold uppercase transition-colors"
                onClick={() => {
                  setShowExportPrompt(false);
                  setShowWipeAuth(true);
                }}
              >
                SKIP EXPORT & PROCEED TO WIPE
              </button>
              <button 
                className="text-slate-500 hover:text-slate-300 text-xs font-bold tracking-widest uppercase mt-2" 
                onClick={() => setShowExportPrompt(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Wipe Text Input Verification */}
      <InputDialog 
        isOpen={showWipeAuth}
        title="TYPE 'WIPE VAULT' TO CONFIRM"
        onConfirm={async (val) => {
          if (val === "WIPE VAULT") {
            try {
              await invoke("cmd_wipe_vault");
              setShowWipeSuccess(true);
            } catch (e) {
              console.error(e);
            }
          }
        }}
        onClose={() => setShowWipeAuth(false)}
      />

      {/* Post-Wipe Action Dialog */}
      {showWipeSuccess && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-[1020] flex items-center justify-center p-4">
          <div className="bg-gunmetal-900 border border-emerald-500 rounded-lg p-6 w-full max-w-sm shadow-[0_0_30px_rgba(16,185,129,0.2)] animate-in fade-in zoom-in-95 flex flex-col items-center text-center">
            <div className="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center mb-4">
              <Trash2 size={32} className="text-emerald-500" />
            </div>
            <h3 className="text-emerald-400 font-bold mb-2 tracking-widest text-lg">
              VAULT DESTROYED
            </h3>
            <p className="text-slate-300 text-sm mb-8 leading-relaxed">
              The vault file and all associated data have been securely zeroized and deleted from the drive.
            </p>
            <div className="flex flex-col gap-3 w-full">
              <button className="btn-primary w-full py-3" onClick={() => invoke("cmd_restart_app")}>
                RESTART BLACKSITE
              </button>
              <button className="text-slate-400 hover:text-slate-200 text-xs font-bold tracking-widest uppercase py-3 border border-ops-600 rounded flex justify-center items-center gap-2 transition-colors hover:bg-ops-700" onClick={() => invoke("cmd_close_app")}>
                <Power size={14} /> EXIT APPLICATION
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

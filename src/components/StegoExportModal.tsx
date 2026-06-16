import React, { useState, useEffect } from "react";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { exportVault, exportStegoVault } from "../lib/tauri";
import { X, Image as ImageIcon, ShieldAlert, FileText, Upload, Check } from "lucide-react";
import { writeFile, BaseDirectory } from "@tauri-apps/plugin-fs";
import { tempDir, join } from "@tauri-apps/api/path";

// Dynamically import all cover images using Vite
const eofImports = import.meta.glob('../assets/stego_covers_eof/*.{png,jpg,jpeg}', { eager: true, query: '?url', import: 'default' });
const PRE_INSTALLED_EOF = Object.values(eofImports) as string[];

const lsbImports = import.meta.glob('../assets/stego_covers_lsb/*.{png,bmp}', { eager: true, query: '?url', import: 'default' });
const PRE_INSTALLED_LSB = Object.values(lsbImports) as string[];

interface StegoExportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type ExportMode = "standard" | "stego_eof" | "stego_lsb";

export const StegoExportModal: React.FC<StegoExportModalProps> = ({ isOpen, onClose }) => {
  const [mode, setMode] = useState<ExportMode>("standard");
  const [carrierPath, setCarrierPath] = useState<string>("");
  const [error, setError] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportComplete, setExportComplete] = useState(false);
  const [finalPath, setFinalPath] = useState("");
  const [isFetchingCover, setIsFetchingCover] = useState<number | null>(null);
  
  const [animKey, setAnimKey] = useState(0);
  const [prevCoverMode, setPrevCoverMode] = useState<ExportMode | null>(null);
  const [isDecryptingCovers, setIsDecryptingCovers] = useState(false);

  useEffect(() => {
    if (mode === "stego_lsb" || mode === "stego_eof") {
      if (prevCoverMode !== mode) {
        setAnimKey(k => k + 1);
        setPrevCoverMode(mode);
        setIsDecryptingCovers(true);
        
        const coversToLoad = mode === "stego_lsb" ? PRE_INSTALLED_LSB : PRE_INSTALLED_EOF;
        
        // Wait for all actual image data to load into the browser's RAM cache
        const loadPromises = coversToLoad.map(src => new Promise(resolve => {
          const img = new Image();
          img.onload = resolve;
          img.onerror = resolve; // Resolve even on error to prevent infinite spin
          img.src = src;
        }));

        Promise.all(loadPromises).then(() => {
          // Minimum 600ms delay just so the scramble text is readable before snapping
          setTimeout(() => setIsDecryptingCovers(false), 600);
        });
      }
    } else {
      setPrevCoverMode(null);
    }
  }, [mode, prevCoverMode]);

  if (!isOpen) return null;

  const handlePickCarrier = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: mode === "stego_lsb" 
          ? [{ name: 'Lossless Images (High-Res/RAW)', extensions: ['png', 'bmp', 'tif', 'tiff', 'webp', 'avif', 'raw', 'nef', 'cr2'] }]
          : [{ name: 'Universal Media (4K Video/Lossless Audio)', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'tif', 'tiff', 'svg', 'eps', 'raw', 'nef', 'cr2', 'mp4', 'mov', 'mkv', 'avi', 'wav', 'aiff', 'flac', 'mp3', 'm4a', 'aac', 'ogg', 'pdf'] }]
      });
      if (selected) {
        setCarrierPath(selected as string);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const handleSelectPreInstalled = async (src: string, index: number) => {
    try {
      setIsFetchingCover(index);
      setError("");
      
      const res = await fetch(src);
      if (!res.ok) throw new Error("Failed to fetch pre-installed cover");
      const buf = await res.arrayBuffer();
      
      // Get the extension, ignoring URL query params (like ?url)
      const ext = src.split('.').pop()?.split('?')[0] || 'png';
      const tempName = `blacksite_temp_carrier_${Date.now()}.${ext}`;
      
      await writeFile(tempName, new Uint8Array(buf), { baseDir: BaseDirectory.Temp });
      
      const tDir = await tempDir();
      const absPath = await join(tDir, tempName);
      
      setCarrierPath(absPath);
    } catch (e) {
      setError(`Failed to load pre-installed cover: ${e}`);
    } finally {
      setIsFetchingCover(null);
    }
  };

  const handleExport = async () => {
    setError("");
    setIsExporting(true);
    setExportProgress(0);
    setExportComplete(false);
    
    try {
      let destPath = "";
      
      if (mode === "standard") {
        destPath = await saveDialog({
          filters: [{ name: 'Blacksite Export', extensions: ['bsx'] }],
          defaultPath: 'vault_export.bsx'
        });
        if (!destPath) { setIsExporting(false); return; }
        
        await exportVault(destPath);
      } else {
        if (!carrierPath) {
          setError("You must select a carrier image first.");
          setIsExporting(false);
          return;
        }

        const ext = carrierPath.split('.').pop() || 'png';
        destPath = await saveDialog({
          filters: [{ name: 'Steganographic Export', extensions: [ext] }],
          defaultPath: `vault_hidden.${ext}`
        });
        if (!destPath) { setIsExporting(false); return; }

        // Start progressive data injection animation
        const interval = setInterval(() => {
          setExportProgress(p => p >= 95 ? 95 : p + Math.floor(Math.random() * 15) + 5);
        }, 150);

        await exportStegoVault(carrierPath, destPath, mode === "stego_lsb" ? "lsb" : "eof");
        clearInterval(interval);
      }
      
      setExportProgress(100);
      setFinalPath(destPath);
      setExportComplete(true);
      
    } catch (e) {
      setError(String(e));
      setIsExporting(false);
    }
  };

  const resetAndClose = () => {
    setExportComplete(false);
    setExportProgress(0);
    setIsExporting(false);
    setCarrierPath("");
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-zinc-800 bg-zinc-900">
          <h2 className="text-slate-100 font-bold tracking-widest text-sm flex items-center gap-2">
            <ShieldAlert size={16} className="text-emerald-500" />
            VAULT EXPORT PROTOCOL
          </h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">
            <X size={18} />
          </button>
        </div>

        {isExporting ? (
          <div className="p-10 flex flex-col items-center justify-center space-y-6">
            {!exportComplete ? (
              <div className="w-full space-y-4 animate-in fade-in zoom-in duration-500">
                <div className="flex items-center justify-between text-emerald-500 font-mono text-xs">
                  <span>PROGRESSIVE DATA INJECTION</span>
                  <span>{exportProgress}%</span>
                </div>
                <div className="w-full h-2 bg-zinc-950 rounded-full overflow-hidden border border-zinc-800">
                  <div 
                    className="h-full bg-emerald-500 transition-all duration-200 ease-out"
                    style={{ width: `${exportProgress}%` }}
                  />
                </div>
                <div className="text-zinc-600 font-mono text-[10px] break-all overflow-hidden h-12 relative">
                  {/* Fake cycling binary matrix effect */}
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="animate-pulse" style={{ animationDelay: `${i * 100}ms` }}>
                      {Array.from({ length: 40 }).map(() => Math.random() > 0.5 ? '1' : '0').join('')}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="w-full flex flex-col items-center justify-center space-y-6 animate-in fade-in zoom-in-95 duration-500">
                <div className="h-16 w-16 bg-emerald-500/20 rounded-full flex items-center justify-center text-emerald-400 ring-1 ring-emerald-500/50 shadow-[0_0_30px_rgba(16,185,129,0.3)]">
                  <Check size={32} />
                </div>
                <div className="text-center space-y-2">
                  <div className="text-slate-100 font-bold tracking-widest text-sm">VAULT SECURED</div>
                  <div className="text-emerald-500 font-mono text-xs break-all max-w-[300px] border border-emerald-500/30 bg-emerald-500/5 p-2 rounded">
                    {finalPath}
                  </div>
                </div>
                <button onClick={resetAndClose} className="btn-primary mt-4 w-full">
                  UNDERSTOOD
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="p-6 space-y-6">
              <div className="space-y-3">
                <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Export Methodology</label>
                <div className="grid grid-cols-1 gap-3">
                  <button 
                    onClick={() => { setMode("standard"); setCarrierPath(""); }}
                    className={`flex flex-col items-start p-3 rounded border text-left transition-colors ${mode === "standard" ? "border-emerald-500 bg-emerald-500/10" : "border-zinc-800 bg-zinc-800/50 hover:border-zinc-600"}`}
                  >
                    <div className="flex items-center gap-2 text-sm font-bold text-slate-200">
                      <FileText size={16} />
                      Standard Export (.bsx)
                    </div>
                    <div className="text-xs text-zinc-400 mt-1">Generates a standard, highly secure encrypted vault file.</div>
                  </button>

                  <button 
                    onClick={() => { setMode("stego_eof"); setCarrierPath(""); }}
                    className={`flex flex-col items-start p-3 rounded border text-left transition-colors ${mode === "stego_eof" ? "border-emerald-500 bg-emerald-500/10" : "border-zinc-800 bg-zinc-800/50 hover:border-zinc-600"}`}
                  >
                    <div className="flex items-center gap-2 text-sm font-bold text-slate-200">
                      <ImageIcon size={16} />
                      Universal Steganography (EOF)
                    </div>
                    <div className="text-xs text-zinc-400 mt-1">Embed vault into ANY file (.jpg, .mp4, .mp3). Plays normally, detectable by deep forensics.</div>
                  </button>

                  <button 
                    onClick={() => { setMode("stego_lsb"); setCarrierPath(""); }}
                    className={`flex flex-col items-start p-3 rounded border text-left transition-colors ${mode === "stego_lsb" ? "border-emerald-500 bg-emerald-500/10" : "border-zinc-800 bg-zinc-800/50 hover:border-zinc-600"}`}
                  >
                    <div className="flex items-center gap-2 text-sm font-bold text-slate-200">
                      <ShieldAlert size={16} />
                      True Stealth Steganography (LSB)
                    </div>
                    <div className="text-xs text-zinc-400 mt-1">Hides vault inside the pixel data of an image. Nearly undetectable. Requires lossless format (PNG, TIFF).</div>
                  </button>
                </div>
              </div>

              {mode !== "standard" && (
                <div className="space-y-3 animate-in fade-in slide-in-from-top-2">
                  <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Select Carrier Image</label>
                  
                  <button 
                    onClick={handlePickCarrier}
                    className="w-full flex items-center justify-center gap-2 p-3 border border-dashed border-zinc-700 rounded text-zinc-300 hover:text-emerald-400 hover:border-emerald-500 transition-colors text-sm"
                  >
                    <Upload size={16} />
                    {carrierPath ? "Change Carrier File..." : "Browse for Carrier File..."}
                  </button>
                  <div className="text-xs text-zinc-500 text-center px-2">
                    {mode === "stego_lsb" 
                      ? "For maximum stealth, use a high-res, lossless picture (PNG, TIFF, RAW)." 
                      : "Works best with 4K video, lossless audio (FLAC/WAV), or high-res pictures."}
                  </div>
                  
                  {carrierPath && (
                    <div className="text-xs text-emerald-500 font-mono truncate bg-zinc-950 p-2 rounded border border-zinc-800">
                      Selected: {carrierPath}
                    </div>
                  )}

                  {/* Pre-installed covers fallback with Digital Scramble Reveal */}
                  {((mode === "stego_lsb" ? PRE_INSTALLED_LSB : PRE_INSTALLED_EOF).length > 0) && (
                    <div key={animKey} className="mt-4 relative overflow-hidden rounded p-2 border border-zinc-800/50 bg-zinc-900/50 min-h-[100px] flex flex-col">
                      <div className="text-xs text-zinc-500 mb-2 relative z-20">Or use a pre-installed cover:</div>
                      
                      {isDecryptingCovers ? (
                        <div className="flex-1 flex items-center justify-center font-mono text-emerald-500 text-xs tracking-widest relative z-20">
                           <div className="animate-pulse flex items-center gap-2">
                             <ShieldAlert size={14} className="animate-spin" style={{ animationDuration: '3s' }} />
                             DECRYPTING_CARRIERS...
                             <span className="cursor-blink" />
                           </div>
                        </div>
                      ) : (
                        <div className="flex gap-3 overflow-x-auto pb-2 relative z-20">
                          {(mode === "stego_lsb" ? PRE_INSTALLED_LSB : PRE_INSTALLED_EOF).map((src, i) => (
                            <div 
                              key={src} 
                              className="relative flex-shrink-0 group"
                            >
                              <img 
                                src={src} 
                                alt="Cover" 
                                onClick={() => handleSelectPreInstalled(src, i)}
                                className={`h-16 w-16 object-cover rounded border transition-all cursor-pointer ${isFetchingCover === i ? 'border-emerald-500 opacity-50' : 'border-zinc-800 hover:border-emerald-400'}`}
                              />
                              {isFetchingCover === i && (
                                <div className="absolute inset-0 flex items-center justify-center">
                                  <div className="h-4 w-4 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin" />
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {error && <div className="text-red-400 text-xs bg-red-950/30 p-2 rounded border border-red-900/50">{error}</div>}
            </div>

            <div className="p-4 border-t border-zinc-800 bg-zinc-900 flex justify-end gap-3">
              <button 
                onClick={resetAndClose}
                className="px-4 py-2 text-xs font-bold text-zinc-400 hover:text-slate-200 transition-colors"
              >
                CANCEL
              </button>
              <button 
                onClick={handleExport}
                disabled={isExporting || (mode !== "standard" && !carrierPath)}
                className="btn-primary"
              >
                EXECUTE EXPORT
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

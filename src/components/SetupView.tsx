import React, { useState, useEffect, useCallback } from "react";
import { RefreshCw, ShieldCheck, AlertTriangle, Copy, Check, Skull, Upload, Eye, EyeOff } from "lucide-react";
import { generatePassphrase, setupVault, importVault, importStegoVault, getAppVersion } from "../lib/tauri";
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { MinimalLineLoader } from "./MinimalLineLoader";
import { AboutModal } from "./AboutModal";
import releasesQr from "../assets/blacksite_node-releases_qr.png";

interface SetupViewProps {
  onSetupComplete: () => void;
}

type Phase = "welcome" | "verify" | "terms" | "generate" | "confirm" | "confirming" | "done" | "import";

export const SetupView: React.FC<SetupViewProps> = ({ onSetupComplete }) => {
  const [masterPassphrase, setMasterPassphrase] = useState<string>("");
  const [canaryPassphrase, setCanaryPassphrase] = useState<string>("");
  const [confirmInput, setConfirmInput] = useState<string>("");
  const [phase, setPhase] = useState<Phase>("welcome");
  const [importMode, setImportMode] = useState<"standard"|"stego_eof"|"stego_lsb">("standard");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [copiedMaster, setCopiedMaster] = useState(false);
  const [copiedCanary, setCopiedCanary] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedPs, setCopiedPs] = useState(false);
  const [appVersion, setAppVersion] = useState<string>("0.1.0");
  const [aboutOpen, setAboutOpen] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [showWarningModal, setShowWarningModal] = useState(false);
  const [wantsToImport, setWantsToImport] = useState(false);

  const [wordCount, setWordCount] = useState<number>(6);
  const [languages, setLanguages] = useState<string[]>(["english"]);

  const [importOldPassphrase, setImportOldPassphrase] = useState<string>("");
  const [showOldPassphrase, setShowOldPassphrase] = useState(false);

  useEffect(() => {
    getAppVersion().then(setAppVersion).catch(console.error);
  }, []);

  const loadPassphrases = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [master, canary] = await Promise.all([
        generatePassphrase(wordCount, languages),
        generatePassphrase(4, languages), // Canary is fixed to 4 words
      ]);
      setMasterPassphrase(master);
      setCanaryPassphrase(canary);
      setConfirmInput("");
      setPhase((prev) => (prev === "welcome" || prev === "terms" || prev === "import" ? prev : "generate"));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [wordCount, languages]);

  useEffect(() => {
    loadPassphrases();
  }, [loadPassphrases]);

  const handleCopy = async (text: string, setter: (v: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(text);
      setter(true);
      setTimeout(() => setter(false), 2000);
    } catch {
      setError("Clipboard access denied.");
    }
  };

  const handleConfirmSetup = async () => {
    if (confirmInput.trim() !== masterPassphrase.trim()) {
      setError("Passphrase mismatch. Re-check your written copy and try again.");
      return;
    }
    setPhase("confirming");
    setError("");
    setLoading(true);
    try {
      await setupVault(masterPassphrase, canaryPassphrase);
      if (wantsToImport) {
        setPhase("import");
      } else {
        setPhase("done");
        setTimeout(onSetupComplete, 1400);
      }
    } catch (e) {
      setError(String(e));
      setPhase("confirm");
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    try {
      const filters = importMode === "standard" 
        ? [{ name: 'Blacksite Export', extensions: ['bsx'] }]
        : importMode === "stego_lsb" 
          ? [{ name: 'Lossless Images (High-Res/RAW)', extensions: ['png', 'bmp', 'tif', 'tiff', 'webp', 'avif', 'raw', 'nef', 'cr2'] }]
          : [{ name: 'Universal Media (4K Video/Lossless Audio)', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'tif', 'tiff', 'svg', 'eps', 'raw', 'nef', 'cr2', 'mp4', 'mov', 'mkv', 'avi', 'wav', 'aiff', 'flac', 'mp3', 'm4a', 'aac', 'ogg', 'pdf'] }];

      const selected = await openDialog({
        multiple: false,
        filters
      });
      if (selected === null) return;
      
      setError("");
      setLoading(true);

      if (importMode === "standard") {
        await importVault(selected as string, importOldPassphrase);
      } else {
        await importStegoVault(selected as string, importOldPassphrase, importMode === "stego_lsb" ? "lsb" : "eof");
      }
      
      setPhase("done");
      setTimeout(onSetupComplete, 1400);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const wordlistSize = Math.max(1, languages.length) * 2048;
  const entropyBits = wordCount * Math.log2(wordlistSize);
  const argon2GuessesPerSec = 1; // 1 guess per second offline
  const timeToCrackSecs = Math.pow(2, entropyBits) / argon2GuessesPerSec;
  
  let timeToCrack = "Instant";
  if (timeToCrackSecs > 1e30 * 3.154e7) timeToCrack = "Heat death of the universe";
  else if (timeToCrackSecs > 1e20 * 3.154e7) timeToCrack = "Cosmic timescale";
  else if (timeToCrackSecs > 1e15 * 3.154e7) timeToCrack = "Quadrillions of years";
  else if (timeToCrackSecs > 1e12 * 3.154e7) timeToCrack = "Trillions of years";
  else if (timeToCrackSecs > 1e9 * 3.154e7) timeToCrack = "Billions of years";
  else if (timeToCrackSecs > 1e6 * 3.154e7) timeToCrack = "Millions of years";
  else if (timeToCrackSecs > 1e3 * 3.154e7) timeToCrack = "Millennia";
  else if (timeToCrackSecs > 100 * 3.154e7) timeToCrack = "Centuries";
  else if (timeToCrackSecs > 3.154e7) timeToCrack = `${Math.floor(timeToCrackSecs / 3.154e7)} years`;
  else if (timeToCrackSecs > 86400) timeToCrack = `${Math.floor(timeToCrackSecs / 86400)} days`;

  const WordTiles = ({ phrase, dimColor = false }: { phrase: string; dimColor?: boolean }) => (
    <div className={`panel-ops p-4 ${dimColor ? "border-amber-warn/40" : ""}`}>
      <div className="flex flex-wrap gap-2 justify-center">
        {phrase.split("-").map((word, i) => (
          <div key={i} className={`border px-3 py-2 text-sm font-mono ${dimColor ? "bg-gunmetal-800 border-amber-warn/30 text-amber-warn" : "bg-gunmetal-800 border-ops-600 text-slate-text"}`}>
            <span className={`text-xs mr-2 ${dimColor ? "text-amber-warn/50" : "text-slate-label"}`}>{i + 1}</span>
            {word}
          </div>
        ))}
      </div>
      <div className={`mt-3 text-center text-xs ${dimColor ? "text-amber-warn/60" : "text-slate-label"}`}>{phrase}</div>
    </div>
  );

  if (phase === "welcome") {
    return (
      <div className="flex flex-col h-full bg-gunmetal-900 text-slate-text font-mono items-center justify-center relative">
        <AboutModal isOpen={aboutOpen} onClose={() => setAboutOpen(false)} appVersion={appVersion} />
        <div className="panel-ops p-12 w-full max-w-2xl z-10 flex flex-col items-center text-center animate-in slide-in-from-bottom-4">
          <img src="/app_logo.png" alt="Blacksite Node" className="h-16 w-auto object-contain mb-6 animate-pulse-slow" />
          <h1 className="text-2xl tracking-widest uppercase text-slate-200 mb-2 font-bold">BLACKSITE NODE</h1>
          <h2 className="text-sm tracking-widest text-emerald-500 mb-8 uppercase font-bold">Sovereign Offline Password Manager</h2>
          
          <div className="space-y-4 text-sm text-slate-dim leading-relaxed mb-8">
            <p>Welcome. You are initializing a high-security, cryptographically hardened vault designed for extreme threat models.</p>
            <p className="font-bold text-slate-300">
              Zero-knowledge Architecture. Cryptographic Security.<br/>No cloud. No account.
            </p>
            <div className="p-4 border border-dashed border-emerald-500/50 bg-emerald-500/5 rounded text-emerald-400/90 text-xs mt-4">
              Blacksite Node is 100% Free, Open Source Software (FOSS). No subscriptions, no telemetry, forever.
              <div className="mt-2 text-ops-500 uppercase tracking-widest font-bold">
                Developed By: Montazar Matlih (github.com/Matlih)
              </div>
            </div>
          </div>
          
          <button className="btn-primary w-full max-w-sm" onClick={() => setPhase("verify")}>
            Proceed
          </button>
        </div>
        <div className="absolute bottom-4 right-6">
          <span onClick={() => setAboutOpen(true)} className="text-xs text-ops-500 font-mono tracking-widest cursor-pointer hover:text-emerald-500 transition-colors">v{appVersion}</span>
        </div>
      </div>
    );
  }

  if (phase === "verify") {
    return (
      <div className="flex flex-col h-full bg-gunmetal-900 text-slate-text font-mono items-center justify-center relative p-8">
        <div className="panel-ops p-10 w-full max-w-2xl z-10 animate-in slide-in-from-right-8">
          <h2 className="text-xl tracking-widest uppercase text-slate-200 mb-6 font-bold flex items-center gap-3">
            <ShieldCheck size={24} className="text-blue-500" />
            MANDATORY SECURITY VERIFICATION
          </h2>

          <div className="border border-blue-500/30 bg-blue-500/5 p-6 rounded mb-8 text-left">
            <p className="text-sm text-slate-300 mb-4 leading-relaxed">
              Before proceeding, you must cryptographically verify that this executable matches the official release hash. 
              Open PowerShell or CMD on this machine and run one of the following commands:
            </p>
            
            <div className="space-y-4 mb-4">
              <div className="flex flex-col gap-1">
                <div className="text-[10px] text-slate-400 font-bold tracking-widest">COMMAND PROMPT (CMD)</div>
                <div className="flex items-center justify-between bg-gunmetal-950 p-3 rounded border border-zinc-800">
                  <code className="font-mono text-xs text-slate-300 select-all">certutil -hashfile blacksite-node.exe SHA256</code>
                  <button onClick={() => handleCopy("certutil -hashfile blacksite-node.exe SHA256", setCopiedCmd)} className="p-2 hover:bg-zinc-800 rounded text-zinc-400 hover:text-emerald-400 transition-colors shrink-0" title="Copy CMD Command">
                    {copiedCmd ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
                  </button>
                </div>
              </div>
              
              <div className="flex flex-col gap-1">
                <div className="text-[10px] text-slate-400 font-bold tracking-widest">POWERSHELL</div>
                <div className="flex items-center justify-between bg-gunmetal-950 p-3 rounded border border-zinc-800">
                  <code className="font-mono text-xs text-slate-300 select-all">Get-FileHash -Path "blacksite-node.exe" -Algorithm SHA256</code>
                  <button onClick={() => handleCopy('Get-FileHash -Path "blacksite-node.exe" -Algorithm SHA256', setCopiedPs)} className="p-2 hover:bg-zinc-800 rounded text-zinc-400 hover:text-emerald-400 transition-colors shrink-0" title="Copy PowerShell Command">
                    {copiedPs ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
                  </button>
                </div>
              </div>
            </div>

            <div className="flex gap-6 p-4 border-t border-blue-500/20 mt-6 pt-4">
              <div className="flex-1 space-y-4">
                <p className="text-xs text-slate-400 leading-relaxed">
                  Use a <strong className="text-slate-200">separate, internet-connected device</strong> to check the official repository release for <strong className="text-blue-active">v{appVersion}</strong>:
                </p>
                <div className="flex items-center gap-2 bg-gunmetal-950 p-2 rounded border border-zinc-800 w-fit">
                  <span className="text-blue-active font-mono text-xs select-all">github.com/Matlih/Blacksite-Node/releases</span>
                  <button onClick={() => handleCopy("github.com/Matlih/Blacksite-Node/releases", setCopiedLink)} className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-blue-active transition-colors shrink-0" title="Copy Link">
                    {copiedLink ? <Check size={14} className="text-blue-500" /> : <Copy size={14} />}
                  </button>
                </div>
                <p className="text-xs text-amber-warn/90 font-bold">
                  Verify that the SHA-256 hash output by your terminal exactly matches the official hash. If they do not match, delete this file immediately and install your preferred version from the official repository release.
                </p>
              </div>
              
              <div className="shrink-0 flex flex-col items-center justify-center bg-white p-2 rounded shadow-inner h-fit self-center gap-1">
                <img src={releasesQr} alt="GitHub Releases QR Code" className="w-32 h-32 object-contain" />
                <span className="text-[10px] font-bold text-gunmetal-900 tracking-wider text-center leading-none mt-1">OFFICIAL RELEASES</span>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between mt-8">
            <button className="text-slate-500 hover:text-slate-300 text-xs tracking-widest uppercase font-bold" onClick={() => setPhase("welcome")}>
              Go Back
            </button>
            <button className="btn-primary" onClick={() => setPhase("terms")}>
              I HAVE VERIFIED THE SHA256 HASH
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "terms") {
    return (
      <div className="flex flex-col h-full bg-gunmetal-900 text-slate-text font-mono items-center justify-center relative overflow-y-auto py-12">
        <AboutModal isOpen={aboutOpen} onClose={() => setAboutOpen(false)} appVersion={appVersion} />
        <div className="panel-ops p-8 w-full max-w-3xl z-10 animate-in slide-in-from-right-8">
          <h2 className="text-lg tracking-widest uppercase text-slate-200 mb-6 flex items-center gap-2"><ShieldCheck size={20} className="text-emerald-500 animate-pulse-slow" /> LICENSE & AGREEMENTS</h2>
          
          <div className="bg-gunmetal-800 border border-ops-700 p-4 rounded h-96 overflow-y-auto text-xs text-slate-dim mb-6 space-y-4 font-mono">
            <p className="font-bold text-slate-300 text-sm">BLACKSITE NODE - OFFLINE SOFTWARE LICENSE</p>
            <p>1. This software is provided "as is", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose and noninfringement.</p>
            <p>2. The user assumes full, sovereign responsibility for their cryptographic keys. There is no password recovery, no cloud backup, and no backdoor.</p>
            <p>3. This application is designed to operate in entirely air-gapped or offline environments. You are responsible for ensuring the physical security of the device this software is executed on.</p>
            <p>4. This application is Free Open Source Software (FOSS) Forever. You are granted rights to use, modify, and distribute this software for any noncommercial purpose as detailed in the PolyForm Noncommercial License below.</p>
            
            <div className="border-t border-ops-700 pt-4 mt-4">
              <p className="font-bold text-slate-300 mb-2">Copyright (c) 2026 Montazar Matlih</p>
              <p className="font-bold mb-4">PolyForm Noncommercial License 1.0.0<br/>&lt;https://polyformproject.org/licenses/noncommercial/1.0.0&gt;</p>

              <p className="font-bold text-slate-400 mt-4">## Acceptance</p>
              <p>In order to get any license under these terms, you must agree to them as both strict obligations and conditions to all your licenses.</p>

              <p className="font-bold text-slate-400 mt-4">## Copyright License</p>
              <p>The licensor grants you a copyright license for the software to do everything you might do with the software that would otherwise infringe the licensor's copyright in it for any permitted purpose. However, you may only distribute the software according to Distribution License and make changes or new works based on the software according to Changes and New Works License.</p>

              <p className="font-bold text-slate-400 mt-4">## Distribution License</p>
              <p>The licensor grants you an additional copyright license to distribute copies of the software. Your license to distribute covers distributing the software with changes and new works permitted by Changes and New Works License.</p>

              <p className="font-bold text-slate-400 mt-4">## Notices</p>
              <p>You must ensure that anyone who gets a copy of any part of the software from you also gets a copy of these terms or the URL for them above, as well as copies of any plain-text lines beginning with `Required Notice:` that the licensor provided with the software.</p>

              <p className="font-bold text-slate-400 mt-4">## Changes and New Works License</p>
              <p>The licensor grants you an additional copyright license to make changes and new works based on the software for any permitted purpose.</p>

              <p className="font-bold text-slate-400 mt-4">## Patent License</p>
              <p>The licensor grants you a patent license for the software that covers patent claims the licensor can license, or becomes able to license, that you would infringe by using the software.</p>

              <p className="font-bold text-slate-400 mt-4">## Noncommercial Purposes</p>
              <p>Any noncommercial purpose is a permitted purpose.</p>

              <p className="font-bold text-slate-400 mt-4">## Personal Uses</p>
              <p>Personal use for research, experiment, and testing for the benefit of public knowledge, personal study, private entertainment, hobby projects, amateur pursuits, or religious observance, without any anticipated commercial application, is use for a permitted purpose.</p>

              <p className="font-bold text-slate-400 mt-4">## Noncommercial Organizations</p>
              <p>Use by any charitable organization, educational institution, public research organization, public safety or health organization, environmental protection organization, or government institution is use for a permitted purpose regardless of the source of funding or obligations resulting from the funding.</p>

              <p className="font-bold text-slate-400 mt-4">## Fair Use</p>
              <p>You may have "fair use" rights for the software under the law. These terms do not limit them.</p>

              <p className="font-bold text-slate-400 mt-4">## No Other Rights</p>
              <p>These terms do not allow you to sublicense or transfer any of your licenses to anyone else, or prevent the licensor from granting licenses to anyone else. These terms do not imply any other licenses.</p>

              <p className="font-bold text-slate-400 mt-4">## Patent Defense</p>
              <p>If you make any written claim that the software infringes or contributes to infringement of any patent, your patent license for the software granted under these terms ends immediately. If your company makes such a claim, your patent license ends immediately for work on behalf of your company.</p>

              <p className="font-bold text-slate-400 mt-4">## Violations</p>
              <p>The first time you are notified in writing that you have violated any of these terms, or done anything with the software not covered by your licenses, your licenses can nonetheless continue if you come into full compliance with these terms, and take practical steps to correct past violations, within 32 days of receiving notice. Otherwise, all your licenses end immediately.</p>

              <p className="font-bold text-slate-400 mt-4">## No Liability</p>
              <p>As far as the law allows, the software comes as is, without any warranty or condition, and the licensor will not be liable to you for any damages arising out of these terms or the use or nature of the software, under any kind of legal claim.</p>

              <p className="font-bold text-slate-400 mt-4">## Definitions</p>
              <p>The licensor is the individual or entity offering these terms, and the software is the software the licensor makes available under these terms.</p>
              <p>You refers to the individual or entity agreeing to these terms.</p>
              <p>Your company is any legal entity, sole proprietorship, or other kind of organization that you work for, plus all organizations that have control over, are under the control of, or are under common control with that organization. Control means ownership of substantially all the assets of an entity, or the power to direct its management and policies by vote, contract, or otherwise. Control can be direct or indirect.</p>
              <p>Your licenses are all the licenses granted to you for the software under these terms.</p>
              <p>Use means anything you do with the software requiring one of your licenses.</p>
            </div>
          </div>



          <div className="flex items-center gap-3 mb-8">
            <input 
              type="checkbox" 
              id="verify-hash"
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
              className="w-4 h-4 accent-emerald-500 cursor-pointer"
            />
            <label htmlFor="verify-hash" className="text-sm text-slate-300 cursor-pointer select-none">
              I have read and agree to the software license, and accept full responsibility for my cryptographic keys.
            </label>
          </div>

          <div className="flex gap-4 w-full">
            <button 
              className="btn-primary flex-1" 
              disabled={!termsAccepted}
              onClick={() => {
                setWantsToImport(false);
                setPhase("generate");
                setShowWarningModal(true);
              }}
            >
              INITIALIZE NEW VAULT
            </button>
            <button 
              className="btn-ghost flex-1 border border-ops-600 hover:border-blue-active text-blue-active disabled:opacity-50 disabled:cursor-not-allowed" 
              disabled={!termsAccepted}
              onClick={() => {
                setWantsToImport(true);
                setPhase("generate");
                setShowWarningModal(true);
              }}
            >
              RESTORE FROM EXPORT
            </button>
          </div>
        </div>
        <div className="absolute bottom-4 right-6">
          <span onClick={() => setAboutOpen(true)} className="text-xs text-ops-500 font-mono tracking-widest cursor-pointer hover:text-emerald-500 transition-colors">v{appVersion}</span>
        </div>
      </div>
    );
  }

  if (phase === "import") {
    return (
      <div className="flex flex-col h-full bg-gunmetal-900 text-slate-text font-mono items-center justify-center relative">
        {loading && <MinimalLineLoader text="IMPORTING VAULT" />}
        <div className="panel-ops p-8 w-full max-w-lg z-10">
          <div className="flex items-center gap-3 mb-4 text-blue-active">
            <Upload size={24} />
            <h2 className="text-lg tracking-widest uppercase">Import Vault</h2>
          </div>
          <p className="text-slate-dim mb-4 text-sm leading-relaxed">
            Select your export file and provide the OLD master passphrase used when it was exported.
          </p>

          <div className="mb-4 space-y-2">
            <label className="text-xs font-bold text-slate-400">IMPORT METHODOLOGY</label>
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
                <input type="radio" checked={importMode === "standard"} onChange={() => setImportMode("standard")} className="accent-blue-active" />
                Standard (.bsx)
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
                <input type="radio" checked={importMode === "stego_eof"} onChange={() => setImportMode("stego_eof")} className="accent-blue-active" />
                Universal Steganography (EOF)
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
                <input type="radio" checked={importMode === "stego_lsb"} onChange={() => setImportMode("stego_lsb")} className="accent-blue-active" />
                True Stealth Steganography (LSB)
              </label>
            </div>
            <div className="text-xs text-zinc-400 mt-2 mb-2 p-2 bg-zinc-900/50 rounded border border-zinc-800">
              {importMode === "stego_lsb" 
                ? "Requires the exact original high-res, lossless picture (PNG, TIFF, RAW). Even 1% compression or metadata stripping will permanently destroy the payload." 
                : importMode === "stego_eof"
                  ? "Works best with 4K video, lossless audio (FLAC/WAV), or high-res pictures. The file must not have been compressed or modified since export."
                  : "Requires the exact, unmodified .bsx file that was generated during your export."}
            </div>
          </div>
          <div className="relative mb-4 w-full">
            <input
              type={showOldPassphrase ? "text" : "password"}
              placeholder="Old Master Passphrase"
              value={importOldPassphrase}
              onChange={(e) => setImportOldPassphrase(e.target.value)}
              className="input-ops w-full pr-10"
              autoFocus
            />
            <button
              onClick={() => setShowOldPassphrase(!showOldPassphrase)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
              title={showOldPassphrase ? "Hide Passphrase" : "Show Passphrase"}
            >
              {showOldPassphrase ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {error && (
            <div className="flex items-center gap-2 text-red-critical text-xs mb-4">
              <AlertTriangle size={12} className="shrink-0" />
              {error}
            </div>
          )}
          <div className="flex gap-4">
            <button className="btn-ghost flex-1" onClick={() => { setPhase("done"); setTimeout(onSetupComplete, 1400); }}>Skip Import</button>
            <button className="btn-primary flex-1" disabled={!importOldPassphrase || loading} onClick={handleImport}>
              {loading ? "Importing..." : "Select File & Import"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gunmetal-900 text-slate-text font-mono relative">
      {showWarningModal && phase === "generate" && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-gunmetal-900/80 backdrop-blur-sm p-8">
          <div className="panel-ops p-8 max-w-lg w-full text-center border-amber-warn/50 animate-in zoom-in-95 duration-200">
            <AlertTriangle size={32} className="text-amber-warn mx-auto mb-4" />
            <h2 className="text-lg tracking-widest uppercase text-amber-warn mb-4 font-bold">WARNING: NO RECOVERY</h2>
            <p className="text-sm text-slate-300 leading-relaxed mb-6 font-mono">
              Take note of your keys, there are no recoveries.<br />
              Your greatest security storage is your brain... and perhaps a piece of paper.
            </p>
            <button onClick={() => setShowWarningModal(false)} className="btn-primary w-full border-amber-warn text-amber-warn hover:bg-amber-warn hover:text-gunmetal-900">
              I UNDERSTAND
            </button>
          </div>
        </div>
      )}
      <AboutModal isOpen={aboutOpen} onClose={() => setAboutOpen(false)} appVersion={appVersion} />
      {(loading || phase === "confirming") && <MinimalLineLoader text="INITIALIZING VAULT" />}
      {/* Header bar */}
      <div className="flex items-center justify-between px-6 py-3 bg-gunmetal-800 border-b border-ops-700">
        <div className="flex items-center gap-3">
          <img src="/app_logo.png" alt="Blacksite Node" className="h-6 w-auto object-contain" />
          <span className="text-xs uppercase tracking-widest text-slate-dim">
            BLACKSITE NODE v{appVersion} — VAULT INITIALIZATION
          </span>
        </div>
        <div className="flex gap-4 items-center text-xs text-slate-label">
          <span>FIRST RUN DETECTED</span>
        </div>
      </div>

      <div className="flex flex-col items-center justify-start flex-1 px-8 max-w-2xl mx-auto w-full overflow-y-auto py-8">

        {phase !== "done" && (
          <>
            {/* Configuration Panel */}
            <div className="w-full mb-6 panel-ops p-4 flex gap-6 items-center">
          <div className="flex-1">
            <label className="label-ops block mb-2">MASTER PASSPHRASE LENGTH: {wordCount} WORDS</label>
            <input 
              type="range" min="5" max="24" value={wordCount} 
              onChange={(e) => setWordCount(parseInt(e.target.value))}
              className="w-full accent-blue-active cursor-pointer"
            />
          </div>
          <div className="flex-1">
            <label className="label-ops block mb-2">BIP-39 WORDLISTS</label>
            <div className="flex flex-wrap gap-2">
              {["english", "spanish", "french", "italian", "portuguese", "czech"].map(lang => (
                <button
                  key={lang}
                  onClick={() => {
                    if (languages.includes(lang) && languages.length > 1) {
                      setLanguages(languages.filter(l => l !== lang));
                    } else if (!languages.includes(lang)) {
                      setLanguages([...languages, lang]);
                    }
                  }}
                  className={`px-3 py-1 text-xs uppercase tracking-wider font-mono border transition-colors ${
                    languages.includes(lang)
                      ? "bg-blue-active text-gunmetal-900 border-blue-active font-bold"
                      : "bg-gunmetal-800 text-slate-dim border-ops-600 hover:border-ops-500 hover:text-slate-text"
                  }`}
                >
                  {lang}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Entropy Display */}
        <div className="w-full mb-5 flex justify-between items-center text-xs text-slate-dim border border-ops-700 bg-gunmetal-800/50 p-3">
          <div><span className="text-slate-label">ENTROPY:</span> {entropyBits.toFixed(1)} bits</div>
          <div><span className="text-slate-label">DICTIONARY:</span> {wordlistSize} words</div>
          <div className="text-blue-active"><span className="text-slate-label">EST. TIME TO CRACK:</span> {timeToCrack}</div>
        </div>

        {/* Status heading */}
        <div className="w-full mb-5">
          {wantsToImport && (
            <div className="mb-4 text-blue-active text-xs border border-blue-active/30 bg-blue-active/5 p-3 text-center uppercase tracking-widest font-bold">
              Restore Mode: First, generate a new secure passphrase for this device. You will select your export file on the next screen.
            </div>
          )}
          <p className="text-slate-dim text-sm leading-relaxed">
            No vault detected. Two sovereign passphrases will be generated:{" "}
            <span className="text-blue-active">Master Key</span> (opens the vault) and{" "}
            <span className="text-amber-warn">Canary Passphrase</span> (silent wipe + decoy).{" "}
            <span className="text-amber-warn">Record both. They are shown once.</span>
          </p>
        </div>
          </>
        )}

        {/* Passphrases */}
        {masterPassphrase && phase !== "done" && (
          <>
            <div className="w-full mb-4">
              <div className="flex items-center justify-between mb-2">
                <div className="label-ops text-blue-active">MASTER PASSPHRASE</div>
                <div className="flex gap-2">
                  <button onClick={() => handleCopy(masterPassphrase, setCopiedMaster)} className="btn-ghost flex items-center gap-1 py-1 px-2 text-xs">
                    {copiedMaster ? <Check size={12} className="text-blue-active" /> : <Copy size={12} />}
                    {copiedMaster ? "COPIED" : "COPY"}
                  </button>
                  <button onClick={loadPassphrases} disabled={loading || phase === "confirm"} className="btn-ghost flex items-center gap-1 py-1 px-2 text-xs" title="Regenerate both passphrases">
                    <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> REGEN
                  </button>
                </div>
              </div>
              <WordTiles phrase={masterPassphrase} dimColor={false} />
            </div>

            <div className="w-full mb-5 animate-in slide-in-from-bottom-2 duration-300">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Skull size={12} className="text-amber-warn animate-pulse-slow" />
                  <div className="label-ops text-amber-warn">CANARY PASSPHRASE (FIXED 4 WORDS)</div>
                </div>
                <button onClick={() => handleCopy(canaryPassphrase, setCopiedCanary)} className="btn-ghost flex items-center gap-1 py-1 px-2 text-xs">
                  {copiedCanary ? <Check size={12} className="text-blue-active" /> : <Copy size={12} />}
                  {copiedCanary ? "COPIED" : "COPY"}
                </button>
              </div>
              <WordTiles phrase={canaryPassphrase} dimColor={true} />
              <div className="mt-2 flex items-start gap-2 text-xs text-amber-warn/80">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span>Duress Key — entering this at the lock screen triggers an immediate silent wipe of the vault. Store separately.</span>
              </div>
            </div>
          </>
        )}

        {/* Confirmation input */}
        {(phase === "generate" || phase === "confirm" || phase === "confirming") && masterPassphrase && (
          <div className="w-full">
            <div className="label-ops mb-2">
              CONFIRM MASTER PASSPHRASE TO ACTIVATE VAULT
              <span className="text-amber-warn ml-2 normal-case font-bold text-[10px]">REMINDER: STORE YOUR KEYS RESPONSIBLY</span>
            </div>
            <input
              type="text"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !loading && handleConfirmSetup()}
              placeholder="word1-word2-word3-..."
              className="input-ops mb-3 w-full"
              disabled={loading || phase === "confirming"}
              autoFocus spellCheck={false} autoComplete="off"
            />
            {error && <div className="flex items-center gap-2 text-red-critical text-xs mb-3"><AlertTriangle size={12} className="shrink-0" />{error}</div>}
            <button onClick={handleConfirmSetup} disabled={loading || !confirmInput || phase === "confirming"} className="btn-primary w-full">
              {loading || phase === "confirming" ? "INITIALIZING VAULT..." : "ACTIVATE VAULT"}
            </button>
          </div>
        )}

        {/* Done */}
        {phase === "done" && (
          <div className="flex flex-col items-center gap-3 text-blue-active">
            <ShieldCheck size={32} />
            <span className="text-sm uppercase tracking-widest">VAULT ACTIVATED</span>
          </div>
        )}
      </div>
    </div>
  );
};

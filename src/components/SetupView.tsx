import React, { useState, useEffect, useCallback } from "react";
import { RefreshCw, ShieldCheck, AlertTriangle, Copy, Check, Skull, Upload } from "lucide-react";
import { generatePassphrase, setupVault, importVault, getAppVersion } from "../lib/tauri";
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { MinimalLineLoader } from "./MinimalLineLoader";

interface SetupViewProps {
  onSetupComplete: () => void;
}

type Phase = "generate" | "confirm" | "confirming" | "done" | "import";

export const SetupView: React.FC<SetupViewProps> = ({ onSetupComplete }) => {
  const [masterPassphrase, setMasterPassphrase] = useState<string>("");
  const [canaryPassphrase, setCanaryPassphrase] = useState<string>("");
  const [confirmInput, setConfirmInput] = useState<string>("");
  const [phase, setPhase] = useState<Phase>("generate");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [copiedMaster, setCopiedMaster] = useState(false);
  const [copiedCanary, setCopiedCanary] = useState(false);
  const [appVersion, setAppVersion] = useState<string>("0.1.0");

  const [wordCount, setWordCount] = useState<number>(6);
  const [languages, setLanguages] = useState<string[]>(["english"]);

  const [importOldPassphrase, setImportOldPassphrase] = useState<string>("");

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
      setPhase("generate");
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
      setPhase("done");
      setTimeout(onSetupComplete, 1400);
    } catch (e) {
      setError(String(e));
      setPhase("confirm");
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{
          name: 'Blacksite Export',
          extensions: ['bsx']
        }]
      });
      if (selected === null) return;
      
      setPhase("import");
      setError("");
      setLoading(true);
      await importVault(selected as string, importOldPassphrase);
      
      // Setup the vault immediately with the newly generated master key
      await setupVault(masterPassphrase, canaryPassphrase);
      setPhase("done");
      setTimeout(onSetupComplete, 1400);
    } catch (e) {
      setError(String(e));
      setPhase("generate"); // Fallback
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
            Please select your `.bsx` export file, and provide the OLD master passphrase used when the file was exported.
            After import, it will be secured under your NEW master passphrase.
          </p>
          <input
            type="password"
            placeholder="Old Master Passphrase"
            value={importOldPassphrase}
            onChange={(e) => setImportOldPassphrase(e.target.value)}
            className="input-ops mb-4 w-full"
            autoFocus
          />
          {error && (
            <div className="flex items-center gap-2 text-red-critical text-xs mb-4">
              <AlertTriangle size={12} className="shrink-0" />
              {error}
            </div>
          )}
          <div className="flex gap-4">
            <button className="btn-ghost flex-1" onClick={() => { setPhase("generate"); setError(""); }}>Cancel</button>
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
          <button className="btn-ghost py-1 px-2 text-blue-active flex items-center gap-1" onClick={() => setPhase("import")}>
            <Upload size={12} /> IMPORT VAULT
          </button>
          <span>FIRST RUN DETECTED</span>
        </div>
      </div>

      <div className="flex flex-col items-center justify-start flex-1 px-8 max-w-2xl mx-auto w-full overflow-y-auto py-8">

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
          <p className="text-slate-dim text-sm leading-relaxed">
            No vault detected. Two sovereign passphrases will be generated:{" "}
            <span className="text-blue-active">Master Key</span> (opens the vault) and{" "}
            <span className="text-amber-warn">Canary Passphrase</span> (silent wipe + decoy).{" "}
            <span className="text-amber-warn">Record both. They are shown once.</span>
          </p>
        </div>

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

            <div className="w-full mb-5">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Skull size={12} className="text-amber-warn" />
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
            <div className="label-ops mb-2">CONFIRM MASTER PASSPHRASE TO ACTIVATE VAULT</div>
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

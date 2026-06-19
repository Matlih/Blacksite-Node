import React, { useState, useEffect, useRef, useCallback } from "react";
import { AlertTriangle, Eye, EyeOff, Vault, Trash2, Power } from "lucide-react";
import { unlockVault, getVaultStatus, getAppVersion } from "../lib/tauri";
import { invoke } from "@tauri-apps/api/core";
import { MinimalLineLoader } from "./MinimalLineLoader";
import { AboutModal } from "./AboutModal";
import { ConfirmDialog } from "./ConfirmDialog";

interface LockScreenProps {
  onUnlock: () => void;
  initialFailedAttempts?: number;
  initialLockoutSecs?: number;
}

export const LockScreen: React.FC<LockScreenProps> = ({
  onUnlock,
  initialFailedAttempts = 0,
  initialLockoutSecs = 0,
}) => {
  const [passphrase, setPassphrase] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [failedAttempts, setFailedAttempts] = useState(initialFailedAttempts);
  const [lockoutSecs, setLockoutSecs] = useState(initialLockoutSecs);
  const [isRevealed, setIsRevealed] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appVersion, setAppVersion] = useState<string>("0.1.0");
  
  const [showWipeConfirm, setShowWipeConfirm] = useState(false);
  const [showWipeAuth, setShowWipeAuth] = useState(false);
  const [showWipeSuccess, setShowWipeSuccess] = useState(false);
  const [showWipeError, setShowWipeError] = useState(false);
  const [wipePassphrase, setWipePassphrase] = useState("");
  
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    getAppVersion().then(setAppVersion).catch(console.error);
  }, []);

  useEffect(() => {
    if (lockoutSecs > 0) {
      timerRef.current = setInterval(() => {
        setLockoutSecs((s) => {
          if (s <= 1) {
            if (timerRef.current) clearInterval(timerRef.current);
            return 0;
          }
          return s - 1;
        });
      }, 1000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [lockoutSecs]);

  const handleUnlock = useCallback(async () => {
    if (loading || lockoutSecs > 0 || !passphrase.trim()) return;

    setLoading(true);
    setError("");

    try {
      await unlockVault(passphrase.trim());
      onUnlock();
    } catch (raw) {
      const msg = String(raw);
      if (msg.startsWith("LOCKED:")) {
        const secs = parseInt(msg.split(":")[1], 10);
        setLockoutSecs(secs);
        const status = await getVaultStatus().catch(() => null);
        if (status) setFailedAttempts(status.failed_attempts);
        setError(`Lockout active. Wait ${secs}s before next attempt.`);
      } else if (msg === "WRONG_PASSPHRASE") {
        const status = await getVaultStatus().catch(() => null);
        if (status) {
          setFailedAttempts(status.failed_attempts);
          setLockoutSecs(status.lockout_remaining_secs);
        }
        setError("Authentication failed. Incorrect passphrase.");
      } else {
        setError(msg);
      }
      setPassphrase("");
      inputRef.current?.focus();
    } finally {
      setLoading(false);
    }
  }, [loading, lockoutSecs, passphrase, onUnlock]);

  const handleWipeAuth = async () => {
    if (!wipePassphrase.trim()) return;
    setLoading(true);
    setError("");

    try {
      // Authenticate
      await unlockVault(wipePassphrase.trim());
      // If success, immediately wipe
      await invoke("cmd_wipe_vault");
      setShowWipeAuth(false);
      setWipePassphrase("");
      setShowWipeSuccess(true);
    } catch (raw: any) {
      const msg = String(raw);
      if (msg.startsWith("LOCKED:")) {
        const secs = parseInt(msg.split(":")[1], 10);
        setLockoutSecs(secs);
        const status = await getVaultStatus().catch(() => null);
        if (status) setFailedAttempts(status.failed_attempts);
        setError(`Lockout active. Wait ${secs}s before next attempt.`);
        setShowWipeAuth(false);
      } else {
        const status = await getVaultStatus().catch(() => null);
        if (status) {
          setFailedAttempts(status.failed_attempts);
          setLockoutSecs(status.lockout_remaining_secs);
        }
        setShowWipeAuth(false);
        setShowWipeError(true);
      }
    } finally {
      setLoading(false);
    }
  };

  const isLocked = lockoutSecs > 0;

  return (
    <div className="flex flex-col h-full bg-gunmetal-900 text-slate-text font-mono relative">
      <AboutModal isOpen={aboutOpen} onClose={() => setAboutOpen(false)} appVersion={appVersion} />
      {loading && <MinimalLineLoader text="AUTHORIZING" />}
      
      <ConfirmDialog 
        isOpen={showWipeConfirm}
        title="WIPE ENTIRE VAULT?"
        message="Are you absolutely sure you want to destroy this vault? This action is mathematically irreversible. All data will be zeroized."
        onConfirm={() => {
          setShowWipeConfirm(false);
          setShowWipeAuth(true);
        }}
        onClose={() => setShowWipeConfirm(false)}
      />

      {/* Wipe Authentication Dialog */}
      {showWipeAuth && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[999] flex items-center justify-center p-4">
          <div className="bg-gunmetal-900 border border-red-critical rounded-lg p-6 w-full max-w-sm shadow-[0_0_30px_rgba(244,63,94,0.3)] animate-in fade-in zoom-in-95">
            <h3 className="text-red-critical font-bold mb-2 flex items-center gap-2 tracking-widest">
              <AlertTriangle size={18} /> VERIFY TO WIPE
            </h3>
            <p className="text-slate-300 text-sm mb-6 leading-relaxed">
              Enter your Master Passphrase to authorize the complete destruction of this vault.
            </p>
            <input 
              type="password" 
              autoFocus
              placeholder="Master Passphrase"
              className="input-ops border-red-critical/50 focus:border-red-critical w-full mb-6" 
              value={wipePassphrase} 
              onChange={(e) => setWipePassphrase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleWipeAuth();
                if (e.key === 'Escape') setShowWipeAuth(false);
              }}
              disabled={loading || isLocked}
            />
            <div className="flex justify-end gap-3">
              <button className="text-slate-400 hover:text-slate-200 text-sm font-bold tracking-widest uppercase px-4" onClick={() => setShowWipeAuth(false)} disabled={loading}>
                Cancel
              </button>
              <button className="bg-red-critical hover:bg-red-critical/80 text-white font-bold py-2 px-6 rounded transition-colors uppercase tracking-widest text-xs flex items-center gap-2" onClick={handleWipeAuth} disabled={loading || isLocked || !wipePassphrase.trim()}>
                <Trash2 size={14} /> AUTHORIZE WIPE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Wipe Error Dialog */}
      {showWipeError && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[1000] flex items-center justify-center p-4">
          <div className="bg-gunmetal-900 border border-amber-warn/50 rounded-lg p-6 w-full max-w-sm shadow-[0_0_30px_rgba(245,158,11,0.2)] animate-in fade-in zoom-in-95 flex flex-col items-center text-center">
            <div className="w-16 h-16 rounded-full bg-amber-warn/10 flex items-center justify-center mb-4">
              <AlertTriangle size={32} className="text-amber-warn" />
            </div>
            <h3 className="text-amber-warn font-bold mb-2 tracking-widest text-lg">
              INCORRECT PASSPHRASE
            </h3>
            <p className="text-slate-300 text-sm mb-8 leading-relaxed">
              The passphrase you entered is incorrect. Do you want to try again or return to the lock screen?
            </p>
            <div className="flex flex-col gap-3 w-full">
              <button 
                className="btn-primary w-full py-3" 
                onClick={() => {
                  setShowWipeError(false);
                  setShowWipeAuth(true);
                  setWipePassphrase("");
                }}
              >
                TRY AGAIN
              </button>
              <button 
                className="text-slate-400 hover:text-slate-200 text-xs font-bold tracking-widest uppercase py-3 border border-ops-600 rounded transition-colors hover:bg-ops-700 w-full" 
                onClick={() => {
                  setShowWipeError(false);
                  setWipePassphrase("");
                }}
              >
                CANCEL WIPE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Post-Wipe Action Dialog */}
      {showWipeSuccess && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-[1000] flex items-center justify-center p-4">
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

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 bg-gunmetal-800 border-b border-ops-700">
        <div className="flex items-center gap-3">
          <span className="text-xs uppercase tracking-widest text-slate-dim">
            BLACKSITE NODE — AUTHENTICATION REQUIRED
          </span>
        </div>
        <div className={`text-xs uppercase ${isLocked ? "text-amber-warn" : "text-slate-label"}`}>
          {isLocked ? `LOCKED — ${lockoutSecs}s` : "VAULT SECURED"}
        </div>
      </div>

      <div className="flex flex-col items-center justify-center flex-1 px-8 max-w-xl mx-auto w-full">
        {/* Main Logo */}
        <div className="mb-8 flex justify-center items-center">
          <img 
            src="/app_logo.png" 
            alt="Blacksite Node" 
            className={`w-24 h-24 object-contain transition-all duration-500 ${isLocked ? "grayscale opacity-50 drop-shadow-[0_0_10px_rgba(251,191,36,0.5)]" : "drop-shadow-[0_0_15px_rgba(56,189,248,0.2)]"}`} 
          />
        </div>

        {/* Terminal prompt + hold-to-reveal input */}
        <div className="w-full mb-2">
          <div className="label-ops mb-2">MASTER PASSPHRASE</div>
          <div className="flex items-center gap-2 bg-gunmetal-800 border border-ops-600 focus-within:border-blue-ops px-3 py-2">
            <Vault size={16} className="text-blue-active shrink-0" />
            <input
              ref={inputRef}
              type={isRevealed ? "text" : "password"}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
              placeholder="word1-word2-word3-word4-word5"
              className="flex-1 bg-transparent outline-none text-slate-text text-sm font-mono placeholder:text-slate-label"
              disabled={loading || isLocked}
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
            {loading && (
              <span className="text-xs text-slate-label animate-pulse">DERIVING KEY...</span>
            )}
            {/* Hold-to-reveal button — text visible only while mousedown */}
            <button
              className={`select-none p-1 transition-colors ${
                isRevealed ? "text-blue-active" : "text-slate-label hover:text-slate-dim"
              }`}
              onMouseDown={() => setIsRevealed(true)}
              onMouseUp={() => setIsRevealed(false)}
              onMouseLeave={() => setIsRevealed(false)}
              title="Hold to reveal passphrase"
              tabIndex={-1}
              disabled={loading || isLocked}
            >
              {isRevealed ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
          </div>
        </div>

        {/* Error / lockout display */}
        {(error || failedAttempts > 0) && (
          <div className="w-full mb-4">
            {error && (
              <div
                className={`flex items-start gap-2 text-xs mb-2 ${
                  isLocked ? "text-amber-warn" : "text-red-critical"
                }`}
              >
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {failedAttempts > 0 && (
              <div className="flex items-center gap-2 text-xs text-slate-dim">
                <div className="flex gap-1">
                  {Array.from({ length: Math.min(failedAttempts, 6) }).map((_, i) => (
                    <div
                      key={i}
                      className={`w-2 h-2 ${
                        i < failedAttempts ? "bg-red-critical" : "bg-ops-600"
                      } ${isLocked ? "animate-pulse-slow" : ""}`}
                    />
                  ))}
                  {failedAttempts > 6 && (
                    <span className="text-red-critical">+{failedAttempts - 6}</span>
                  )}
                </div>
                <span className="text-slate-label">
                  {failedAttempts} failed attempt{failedAttempts !== 1 ? "s" : ""}
                </span>
              </div>
            )}

            {isLocked && (
              <div className="mt-3 w-full">
                <div className="h-1 bg-ops-700 w-full">
                  <div
                    className="h-1 bg-amber-warn transition-all duration-1000"
                    style={{
                      width: `${Math.max(
                        0,
                        (lockoutSecs / getLockoutMax(failedAttempts)) * 100
                      )}%`,
                    }}
                  />
                </div>
                <div className="text-xs text-amber-warn mt-1 text-right">
                  LOCKOUT: {lockoutSecs}s remaining
                </div>
              </div>
            )}
          </div>
        )}

        <button
          onClick={handleUnlock}
          disabled={loading || isLocked || !passphrase.trim()}
          className="btn-primary w-full"
        >
          {loading
            ? "AUTHENTICATING..."
            : isLocked
            ? `LOCKED — ${lockoutSecs}s`
            : "UNLOCK VAULT"}
        </button>

        <div className="mt-6 text-xs text-slate-label text-center leading-relaxed">
          Argon2id · ChaCha20-Poly1305 · CSPRNG · Zero-knowledge<br/>
          <span 
            onClick={() => setAboutOpen(true)}
            className="cursor-pointer hover:text-emerald-500 transition-colors inline-block pt-1"
          >
            v{appVersion}
          </span>
          <div className="mt-4 flex justify-center">
            <button 
              onClick={() => setShowWipeConfirm(true)}
              className="text-[10px] text-slate-500 hover:text-red-critical transition-colors tracking-widest uppercase flex items-center gap-1 opacity-50 hover:opacity-100"
            >
              <Trash2 size={10} /> Factory Reset / Wipe Vault
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

function getLockoutMax(attempts: number): number {
  if (attempts <= 2) return 1;
  if (attempts === 3) return 3;
  if (attempts === 4) return 10;
  if (attempts === 5) return 30;
  return 60;
}

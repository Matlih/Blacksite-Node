import React, { useState, useEffect, useCallback } from "react";
import {
  Lock, Plus, Trash2, Eye, EyeOff, Copy, Check, Zap, ShieldCheck,
  Search, AlertTriangle, Edit2, History, XCircle, Download, ChevronDown, ChevronUp
} from "lucide-react";
import type { CredentialEntry, PasswordHistoryEntry } from "../lib/tauri";
import { 
  getCredentials, addCredential, editCredential, deleteCredential, 
  deleteHistoryEntry, lockVault, getAppVersion, exportVault, secureCopy 
} from "../lib/tauri";
import { GeneratorModal } from "./GeneratorModal";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { IrisShutterLoader } from "./IrisShutterLoader";
import { StegoExportModal } from "./StegoExportModal";

interface VaultViewProps {
  onLock: () => void;
}

interface CredentialForm {
  id?: string;
  service: string;
  username: string;
  password: string;
  notes: string;
  category: string;
}

const EMPTY_FORM: CredentialForm = {
  service: "",
  username: "",
  password: "",
  notes: "",
  category: "",
};

type SortField = "service" | "username" | "created_at" | "updated_at" | "category";
type SortDirection = "asc" | "desc";

const calculateMLStrength = (pwd: string): { score: number, label: string, color: string } => {
  // TODO: Hook up Random Forest / LSTM model here.
  // For now, this is a dummy hook that returns a score based on length and charset.
  if (!pwd) return { score: 0, label: "NONE", color: "bg-ops-700" };
  let entropy = 0;
  if (/[a-z]/.test(pwd)) entropy += 26;
  if (/[A-Z]/.test(pwd)) entropy += 26;
  if (/[0-9]/.test(pwd)) entropy += 10;
  if (/[^a-zA-Z0-9]/.test(pwd)) entropy += 32;
  const bits = pwd.length * Math.log2(entropy || 1);
  if (bits < 40) return { score: Math.min(33, bits), label: "WEAK", color: "bg-red-500" };
  if (bits < 60) return { score: Math.min(66, bits), label: "FAIR", color: "bg-yellow-500" };
  return { score: Math.min(100, bits), label: "STRONG", color: "bg-green-500" };
};



export const VaultView: React.FC<VaultViewProps> = ({ onLock }) => {
  const [entries, setEntries] = useState<CredentialEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [historyOpenId, setHistoryOpenId] = useState<string | null>(null);
  
  const [showForm, setShowForm] = useState(false);
  const [formMode, setFormMode] = useState<"add" | "edit">("add");
  const [form, setForm] = useState<CredentialForm>(EMPTY_FORM);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState("");
  
  const [showGenerator, setShowGenerator] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  

  const [locking, setLocking] = useState(false);
  const [showLockAnimation, setShowLockAnimation] = useState(false);
  const [appVersion, setAppVersion] = useState<string>("0.1.0");

  const [sortField, setSortField] = useState<SortField>("service");
  const [sortDir, setSortDir] = useState<SortDirection>("asc");

  const [inactivityMinutes, setInactivityMinutes] = useState<number>(() => {
    const stored = localStorage.getItem("blacksite_autolock_mins");
    return stored ? parseInt(stored, 10) : 5;
  });

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getCredentials();
      setEntries(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEntries();
    getAppVersion().then(setAppVersion).catch(console.error);
  }, [loadEntries]);

  const handleLock = useCallback(async (isManual: boolean = false) => {
    if (isManual === true) {
      setShowLockAnimation(true);
      await new Promise(r => setTimeout(r, 2400));
    }
    setLocking(true);
    setRevealedIds(new Set());
    try {
      await lockVault();
      onLock();
    } catch (e) {
      setError(String(e));
      setLocking(false);
      setShowLockAnimation(false);
    }
  }, [onLock]);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;

    const resetTimer = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        handleLock();
      }, inactivityMinutes * 60 * 1000);
    };

    window.addEventListener("mousemove", resetTimer);
    window.addEventListener("keydown", resetTimer);
    window.addEventListener("click", resetTimer);

    resetTimer();

    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener("mousemove", resetTimer);
      window.removeEventListener("keydown", resetTimer);
      window.removeEventListener("click", resetTimer);
    };
  }, [inactivityMinutes, handleLock]);

  const handleExport = () => {
    setExportModalOpen(true);
  };

  const toggleReveal = (id: string) => {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCopyPassword = async (entry: CredentialEntry | PasswordHistoryEntry, id: string) => {
    try {
      try {
        await secureCopy(entry.password);
      } catch {
        await navigator.clipboard.writeText(entry.password);
      }
      setCopiedId(id);
      setTimeout(async () => {
        try { 
          await secureCopy(""); 
        } catch { 
          try { await navigator.clipboard.writeText(""); } catch { /* ignore */ }
        }
      }, 30000);
      setTimeout(() => setCopiedId((cId) => (cId === id ? null : cId)), 2000);
    } catch {
      setError("Clipboard access denied.");
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.service.trim() || !form.password.trim()) {
      setFormError("Service and password are required.");
      return;
    }
    setFormLoading(true);
    setFormError("");
    try {
      if (formMode === "add") {
        await addCredential(form.service.trim(), form.username.trim(), form.password, form.notes.trim(), form.category);
      } else if (formMode === "edit" && form.id) {
        await editCredential(form.id, form.service.trim(), form.username.trim(), form.password, form.notes.trim(), form.category);
      }
      setForm(EMPTY_FORM);
      setShowForm(false);
      await loadEntries();
    } catch (e) {
      setFormError(String(e));
    } finally {
      setFormLoading(false);
    }
  };

  const openEdit = (entry: CredentialEntry) => {
    setFormMode("edit");
    setForm({
      id: entry.id,
      service: entry.service,
      username: entry.username,
      password: entry.password,
      notes: entry.notes,
      category: entry.category || "",
    });
    setShowForm(true);
    setFormError("");
  };

  const handleDelete = async (id: string) => {
    if (deleteConfirm !== id) {
      setDeleteConfirm(id);
      setTimeout(() => setDeleteConfirm(null), 3000);
      return;
    }
    try {
      await deleteCredential(id);
      setDeleteConfirm(null);
      await loadEntries();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDeleteHistory = async (id: string, retiredAt: number) => {
    try {
      await deleteHistoryEntry(id, retiredAt);
      await loadEntries();
    } catch (e) {
      setError(String(e));
    }
  };



  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const filteredAndSortedEntries = entries
    .filter((e) => {
      const q = searchQuery.toLowerCase();
      const matchSearch = !q || e.service.toLowerCase().includes(q) || e.username.toLowerCase().includes(q) || e.notes.toLowerCase().includes(q);
      const matchCat = !categoryFilter || e.category === categoryFilter;
      return matchSearch && matchCat;
    })
    .sort((a, b) => {
      let aVal = a[sortField] || "";
      let bVal = b[sortField] || "";
      if (typeof aVal === "string" && typeof bVal === "string") {
        aVal = aVal.toLowerCase();
        bVal = bVal.toLowerCase();
      }
      if (aVal < bVal) return sortDir === "asc" ? -1 : 1;
      if (aVal > bVal) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortDir === "asc" ? <ChevronUp size={12} className="inline ml-1" /> : <ChevronDown size={12} className="inline ml-1" />;
  };

  const allCategories = Array.from(new Set(entries.map(e => e.category).filter(Boolean))) as string[];
  const presets = ["Work", "Personal", "Finance", "Social", "Shopping", "Other"];
  const filterOptions = Array.from(new Set([...presets, ...allCategories]));

  return (
    <div className="flex flex-col h-full bg-gunmetal-900 text-slate-text font-mono overflow-hidden relative">
      {showLockAnimation && <IrisShutterLoader />}
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-3 bg-gunmetal-800 border-b border-ops-700 shrink-0">
        <div className="flex items-center gap-3">
          <img src="/app_logo.png" alt="Blacksite Node" className="h-6 w-auto object-contain" />
          <span className="text-xs uppercase tracking-widest text-slate-dim hidden md:inline">BLACKSITE NODE</span>
          <span className="text-xs text-ops-500 select-none">|</span>
          <span className="text-xs text-blue-active">{entries.length} CREDENTIAL{entries.length !== 1 ? "S" : ""}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 mr-2 hidden sm:flex">
            <span className="text-xs text-slate-dim">AUTO-LOCK:</span>
            <select
              value={inactivityMinutes}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                setInactivityMinutes(val);
                localStorage.setItem("blacksite_autolock_mins", val.toString());
              }}
              className="bg-transparent text-xs text-ops-500 hover:text-blue-active outline-none cursor-pointer"
            >
              <option value={1} className="bg-gunmetal-900">1 MIN</option>
              <option value={5} className="bg-gunmetal-900">5 MIN</option>
              <option value={10} className="bg-gunmetal-900">10 MIN</option>
              <option value={15} className="bg-gunmetal-900">15 MIN</option>
              <option value={30} className="bg-gunmetal-900">30 MIN</option>
            </select>
          </div>

          <button onClick={handleExport} className="btn-ghost flex items-center gap-1 py-1 px-2 text-xs">
            <Download size={12} /> EXPORT
          </button>
          <button onClick={() => setShowGenerator(true)} className="btn-ghost flex items-center gap-1 py-1 px-2 text-xs">
            <Zap size={12} /> GEN
          </button>
          <button onClick={() => { setShowForm(true); setFormMode("add"); setForm(EMPTY_FORM); setFormError(""); }} className="btn-primary flex items-center gap-1 py-1 px-2 text-xs">
            <Plus size={12} /> ADD
          </button>
          <button onClick={() => handleLock(true)} disabled={locking || showLockAnimation} className="btn-danger flex items-center gap-1 py-1 px-2 text-xs">
            <Lock size={12} /> {locking || showLockAnimation ? "LOCKING..." : "LOCK"}
          </button>
        </div>
      </div>

      {/* Search bar */}
      <div className="px-5 py-2 bg-gunmetal-800 border-b border-ops-700 shrink-0 flex gap-2">
        <div className="flex-1 flex items-center gap-2 bg-gunmetal-900 border border-ops-600 px-3 py-1.5 focus-within:border-blue-ops">
          <Search size={12} className="text-slate-label shrink-0" />
          <input
            type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="filter by service, username, notes..."
            className="flex-1 bg-transparent outline-none text-slate-text text-xs font-mono placeholder:text-slate-label"
          />
        </div>
        <select 
          value={categoryFilter} 
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="bg-gunmetal-900 border border-ops-600 px-3 py-1.5 text-xs text-slate-text outline-none focus:border-blue-ops cursor-pointer uppercase"
        >
          <option value="">ALL CATEGORIES</option>
          {filterOptions.map(cat => <option key={cat} value={cat}>{cat.toUpperCase()}</option>)}
        </select>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-5 py-2 bg-red-dim border-b border-red-muted flex items-center gap-2 text-xs text-red-critical shrink-0">
          <AlertTriangle size={12} /> {error}
          <button onClick={() => setError("")} className="ml-auto text-slate-label hover:text-slate-text">
            <XCircle size={12} />
          </button>
        </div>
      )}

      {/* Add/Edit credential form */}
      {showForm && (
        <div className="px-5 py-4 bg-ops-900 border-b border-ops-700 shrink-0">
          <div className="label-ops mb-3">{formMode === "add" ? "NEW CREDENTIAL" : "EDIT CREDENTIAL"}</div>
          <form onSubmit={handleFormSubmit}>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div>
                <div className="label-ops mb-1 text-xs">SERVICE *</div>
                <input type="text" value={form.service} onChange={(e) => setForm(f => ({...f, service: e.target.value}))} placeholder="github.com" className="input-ops" autoFocus required />
              </div>
              <div>
                <div className="label-ops mb-1 text-xs">CATEGORY</div>
                <input 
                  type="text" 
                  list="categories" 
                  value={form.category} 
                  onChange={(e) => setForm(f => ({...f, category: e.target.value}))} 
                  className="input-ops uppercase" 
                  placeholder="Select or type..." 
                />
                <datalist id="categories">
                  {filterOptions.map(cat => <option key={cat} value={cat} />)}
                </datalist>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div>
                <div className="label-ops mb-1 text-xs">USERNAME / EMAIL</div>
                <input type="text" value={form.username} onChange={(e) => setForm(f => ({...f, username: e.target.value}))} placeholder="user@domain.com" className="input-ops" />
              </div>
              <div>
                <div className="label-ops mb-1 text-xs">NOTES</div>
                <input type="text" value={form.notes} onChange={(e) => setForm(f => ({...f, notes: e.target.value}))} placeholder="optional" className="input-ops" />
              </div>
            </div>
            <div className="mb-3">
                <div className="flex items-center justify-between mb-1">
                  <div className="label-ops text-xs">PASSWORD *</div>
                  <button type="button" onClick={() => setShowGenerator(true)} className="text-xs text-blue-ops hover:text-blue-active uppercase tracking-wider">generate →</button>
                </div>
                <input type="password" value={form.password} onChange={(e) => setForm(f => ({...f, password: e.target.value}))} placeholder="••••••••••••" className="input-ops mb-1" required />
                {form.password && (
                  <div className="flex items-center gap-2">
                    <div className="h-1 flex-1 bg-ops-800 rounded overflow-hidden">
                      <div className={`h-full ${calculateMLStrength(form.password).color}`} style={{ width: `${calculateMLStrength(form.password).score}%`, transition: 'width 0.3s ease' }}></div>
                    </div>
                    <span className={`text-[10px] font-bold ${calculateMLStrength(form.password).color.replace('bg-', 'text-')}`}>
                      {calculateMLStrength(form.password).label}
                    </span>
                  </div>
                )}
            </div>
            {formError && <div className="text-red-critical text-xs mb-2 flex items-center gap-1"><AlertTriangle size={10} />{formError}</div>}
            <div className="flex gap-2">
              <button type="button" onClick={() => setShowForm(false)} className="btn-ghost flex-1">CANCEL</button>
              <button type="submit" disabled={formLoading} className="btn-primary flex-1">{formLoading ? "ENCRYPTING..." : "SAVE CREDENTIAL"}</button>
            </div>
          </form>
        </div>
      )}

      {/* Import Wizard Modal */}


      {/* Credentials table */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-slate-label text-xs">LOADING VAULT...</div>
        ) : filteredAndSortedEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-slate-label text-xs gap-2">
            {searchQuery ? (
              <><Search size={24} className="opacity-30" /><span>NO RESULTS FOR "{searchQuery.toUpperCase()}"</span></>
            ) : (
              <><ShieldCheck size={24} className="opacity-30" /><span>VAULT IS EMPTY — ADD YOUR FIRST CREDENTIAL</span></>
            )}
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-gunmetal-800 border-b border-ops-700 select-none">
                <th className="text-left px-5 py-2 label-ops text-xs cursor-pointer hover:text-slate-text" onClick={() => toggleSort("service")}>SERVICE <SortIcon field="service"/></th>
                <th className="text-left px-3 py-2 label-ops text-xs cursor-pointer hover:text-slate-text" onClick={() => toggleSort("category")}>CATEGORY <SortIcon field="category"/></th>
                <th className="text-left px-3 py-2 label-ops text-xs cursor-pointer hover:text-slate-text" onClick={() => toggleSort("username")}>USERNAME <SortIcon field="username"/></th>
                <th className="text-left px-3 py-2 label-ops text-xs">PASSWORD</th>
                <th className="text-left px-3 py-2 label-ops text-xs cursor-pointer hover:text-slate-text hidden md:table-cell" onClick={() => toggleSort("updated_at")}>UPDATED <SortIcon field="updated_at"/></th>
                <th className="text-left px-3 py-2 label-ops text-xs hidden lg:table-cell">NOTES</th>
                <th className="px-3 py-2 label-ops text-xs text-right">ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {filteredAndSortedEntries.map((entry) => {
                const isRevealed = revealedIds.has(entry.id);
                const isCopied = copiedId === entry.id;
                const isDeleteConfirm = deleteConfirm === entry.id;
                const isHistoryOpen = historyOpenId === entry.id;
                const hasHistory = entry.password_history && entry.password_history.length > 0;

                return (
                  <React.Fragment key={entry.id}>
                    <tr className="table-row-ops border-b border-ops-800/50">
                      <td className="px-5 py-3 text-sm text-slate-text">{entry.service}</td>
                      <td className="px-3 py-3 text-xs">
                        {entry.category ? (
                          <span className="bg-ops-700/50 text-blue-ops px-2 py-0.5 rounded uppercase tracking-wider border border-ops-600">{entry.category}</span>
                        ) : (
                          <span className="text-slate-label italic">Uncat</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-sm text-slate-dim">{entry.username || "—"}</td>
                      <td className="px-3 py-3 text-sm font-mono">
                        <span className={isRevealed ? "text-slate-text select-all" : "text-slate-label tracking-widest select-none"}>
                          {isRevealed ? entry.password : "•".repeat(Math.min(entry.password.length, 16))}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-dim hidden md:table-cell">{new Date(entry.updated_at * 1000).toLocaleDateString()}</td>
                      <td className="px-3 py-3 text-xs text-slate-label hidden lg:table-cell">{entry.notes || "—"}</td>
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {hasHistory && (
                            <button onClick={() => setHistoryOpenId(isHistoryOpen ? null : entry.id)} className={`p-1.5 transition-colors ${isHistoryOpen ? 'text-blue-active' : 'text-slate-label hover:text-slate-text'}`} title="View password history">
                              <History size={13} />
                            </button>
                          )}
                          <button onClick={() => toggleReveal(entry.id)} className="p-1.5 text-slate-label hover:text-slate-text transition-colors" title={isRevealed ? "Hide password" : "Reveal password"}>
                            {isRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                          <button onClick={() => handleCopyPassword(entry, entry.id)} className={`p-1.5 transition-colors ${isCopied ? "text-blue-active" : "text-slate-label hover:text-slate-text"}`} title="Copy password">
                            {isCopied ? <Check size={13} /> : <Copy size={13} />}
                          </button>
                          <button onClick={() => openEdit(entry)} className="p-1.5 text-slate-label hover:text-blue-active transition-colors" title="Edit credential">
                            <Edit2 size={13} />
                          </button>
                          <button onClick={() => handleDelete(entry.id)} className={`p-1.5 transition-colors ${isDeleteConfirm ? "text-red-critical animate-pulse" : "text-slate-label hover:text-red-alert"}`} title={isDeleteConfirm ? "Click again to confirm delete" : "Delete credential"}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isHistoryOpen && hasHistory && (
                      <tr className="bg-gunmetal-800/30">
                        <td colSpan={5} className="px-5 py-3">
                          <div className="text-xs label-ops mb-2 text-slate-label">PASSWORD HISTORY</div>
                          <div className="flex flex-col gap-2">
                            {entry.password_history.map((hist, idx) => {
                              const histCopied = copiedId === `${entry.id}-hist-${idx}`;
                              return (
                                <div key={idx} className="flex items-center justify-between bg-gunmetal-900 border border-ops-700 px-3 py-2">
                                  <div className="flex items-center gap-4">
                                    <span className="font-mono text-sm text-slate-dim">{isRevealed ? hist.password : "•".repeat(Math.min(hist.password.length, 16))}</span>
                                    <span className="text-xs text-slate-label">Retired: {new Date(hist.retired_at * 1000).toLocaleString()}</span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <button onClick={() => handleCopyPassword(hist as any, `${entry.id}-hist-${idx}`)} className={`p-1 text-slate-label hover:text-slate-text ${histCopied ? "text-blue-active" : ""}`}>
                                      {histCopied ? <Check size={12} /> : <Copy size={12} />}
                                    </button>
                                    <button onClick={() => handleDeleteHistory(entry.id, hist.retired_at)} className="p-1 text-slate-label hover:text-red-alert">
                                      <Trash2 size={12} />
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Status bar */}
      <div className="px-5 py-1.5 bg-gunmetal-800 border-t border-ops-700 flex items-center justify-between shrink-0">
        <span className="text-xs text-slate-label">{filteredAndSortedEntries.length} of {entries.length} entries</span>
        <span className="text-xs text-slate-label hidden md:inline">VAULT · ENCRYPTED AT REST · ZERO-KNOWLEDGE</span>
        <span className="text-xs text-ops-500 font-mono tracking-widest">v{appVersion}</span>
      </div>

      {/* Generator modal */}
      {showGenerator && (
        <GeneratorModal
          onClose={() => setShowGenerator(false)}
          onUsePassword={(pw) => {
            setForm((f) => ({ ...f, password: pw }));
            setShowGenerator(false);
            setShowForm(true);
          }}
        />
      )}

      {/* Stego Export modal */}
      <StegoExportModal 
        isOpen={exportModalOpen} 
        onClose={() => setExportModalOpen(false)} 
      />
    </div>
  );
};

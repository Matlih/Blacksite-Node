import React, { useState, useEffect, useMemo } from "react";
import { Search, Plus, Pin, FolderPlus, X, Check, Folder, Edit2, Trash2, ChevronDown } from "lucide-react";
import type { SecureNote, NoteFolder } from "../lib/tauri";
import { getNotes, addNote, editNote, deleteNote, getNoteFolders, addNoteFolder, editNoteFolder, deleteNoteFolder } from "../lib/tauri";
import { InputDialog } from "./InputDialog";
import { ConfirmDialog } from "./ConfirmDialog";

function formatNoteDate(timestampSecs: number): string {
  const date = new Date(timestampSecs * 1000);
  const now = new Date();
  
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  const diffDays = Math.round((today.getTime() - d.getTime()) / (1000 * 3600 * 24));
  const pad = (n: number) => n.toString().padStart(2, "0");
  const timeStr = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  
  if (diffDays === 0) return timeStr;
  if (diffDays === 1) return `Yesterday ${timeStr}`;
  
  if (diffDays > 1 && diffDays < 7) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `${days[date.getDay()]} ${timeStr}`;
  }
  
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  if (date.getFullYear() === now.getFullYear()) {
    return `${months[date.getMonth()]} ${date.getDate()}`;
  }
  
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

export const NotesView: React.FC = () => {
  const [notes, setNotes] = useState<SecureNote[]>([]);
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  
  const [editingNote, setEditingNote] = useState<SecureNote | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  
  // Editor State
  const [editorTitle, setEditorTitle] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [editorFolderId, setEditorFolderId] = useState<string | null>(null);
  const [editorIsPinned, setEditorIsPinned] = useState(false);
  const [isFolderSelectOpen, setIsFolderSelectOpen] = useState(false);
  
  // Folder Context Menu State
  const [folderContextMenu, setFolderContextMenu] = useState<{ x: number, y: number, folderId: string, folderName: string } | null>(null);

  const [inputDialog, setInputDialog] = useState<{isOpen: boolean, title: string, initialValue: string, onConfirm: (val: string) => void}>({isOpen: false, title: "", initialValue: "", onConfirm: () => {}});
  const [confirmDialog, setConfirmDialog] = useState<{isOpen: boolean, title: string, message: string, onConfirm: () => void}>({isOpen: false, title: "", message: "", onConfirm: () => {}});

  const loadData = async () => {
    try {
      const [n, f] = await Promise.all([getNotes(), getNoteFolders()]);
      setNotes(n);
      setFolders(f);
    } catch (e) {
      console.error("Failed to load notes:", e);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleAddFolder = async () => {
    setInputDialog({
      isOpen: true,
      title: "New folder name:",
      initialValue: "",
      onConfirm: async (name) => {
        if (name && name.trim()) {
          await addNoteFolder(name.trim());
          await loadData();
        }
      }
    });
  };

  const handleRenameFolder = async (id: string, oldName: string) => {
    setInputDialog({
      isOpen: true,
      title: "Rename folder:",
      initialValue: oldName,
      onConfirm: async (name) => {
        if (name && name.trim() && name !== oldName) {
          await editNoteFolder(id, name.trim());
          await loadData();
        }
      }
    });
    setFolderContextMenu(null);
  };

  const handleDeleteFolder = async (id: string) => {
    setConfirmDialog({
      isOpen: true,
      title: "Delete Folder",
      message: "Delete this folder? Notes inside will be moved to 'All'.",
      onConfirm: async () => {
        await deleteNoteFolder(id);
        if (activeFolderId === id) setActiveFolderId(null);
        await loadData();
      }
    });
    setFolderContextMenu(null);
  };

  const openEditor = (note?: SecureNote) => {
    if (note) {
      setEditingNote(note);
      setEditorTitle(note.title);
      setEditorContent(note.content);
      setEditorFolderId(note.folder_id || null);
      setEditorIsPinned(note.is_pinned);
    } else {
      setEditingNote(null);
      setEditorTitle("");
      setEditorContent("");
      setEditorFolderId(activeFolderId);
      setEditorIsPinned(false);
    }
    setIsEditorOpen(true);
  };

  const saveNote = async () => {
    try {
      if (editingNote) {
        await editNote(editingNote.id, editorTitle, editorContent, editorFolderId, editorIsPinned);
      } else {
        await addNote(editorTitle || "Untitled Note", editorContent, editorFolderId, editorIsPinned);
      }
      await loadData();
      setIsEditorOpen(false);
    } catch (e) {
      console.error("Failed to save note", e);
    }
  };

  const handleDeleteNote = async (id: string) => {
    setConfirmDialog({
      isOpen: true,
      title: "Delete Note",
      message: "Delete this note permanently?",
      onConfirm: async () => {
        await deleteNote(id);
        await loadData();
        setIsEditorOpen(false);
      }
    });
  };

  const filteredNotes = useMemo(() => {
    let filtered = notes;
    if (activeFolderId !== null) {
      filtered = filtered.filter(n => n.folder_id === activeFolderId);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(n => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q));
    }
    
    // Sort: Pinned first, then by updated_at descending
    return filtered.sort((a, b) => {
      if (a.is_pinned && !b.is_pinned) return -1;
      if (!a.is_pinned && b.is_pinned) return 1;
      return b.updated_at - a.updated_at;
    });
  }, [notes, activeFolderId, searchQuery]);

  return (
    <div className="flex flex-col h-full bg-gunmetal-900 text-slate-text font-mono relative" onClick={() => setFolderContextMenu(null)}>
      
      {/* Top Search Bar */}
      <div className="px-4 py-3 bg-gunmetal-800 border-b border-ops-700 shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={16} />
          <input
            type="text"
            placeholder="Search notes"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full bg-zinc-900/50 border border-ops-700 rounded-full py-2 pl-10 pr-4 text-sm text-slate-200 placeholder:text-zinc-600 focus:outline-none focus:border-blue-active focus:ring-1 focus:ring-blue-active transition-all"
          />
        </div>
      </div>

      {/* Horizontal Folder Chips */}
      <div className="flex items-center gap-2 px-4 py-3 overflow-x-auto hide-scrollbar border-b border-ops-700/50 shrink-0">
        <button
          onClick={() => setActiveFolderId(null)}
          className={`px-4 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors ${activeFolderId === null ? "bg-slate-200 text-gunmetal-900" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}
        >
          All
        </button>
        {folders.map(f => (
          <button
            key={f.id}
            onClick={() => setActiveFolderId(f.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setFolderContextMenu({ folderId: f.id, folderName: f.name, x: e.clientX, y: e.clientY });
            }}
            className={`px-4 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors ${activeFolderId === f.id ? "bg-slate-200 text-gunmetal-900" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}
          >
            {f.name}
          </button>
        ))}
        <button onClick={handleAddFolder} className="p-1.5 rounded-full bg-ops-700 text-blue-active hover:bg-ops-600 transition-colors shrink-0">
          <FolderPlus size={16} />
        </button>
      </div>

      {/* Folder Context Menu */}
      {folderContextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setFolderContextMenu(null)} onContextMenu={(e) => { e.preventDefault(); setFolderContextMenu(null); }}></div>
          <div 
            className="fixed z-50 bg-gunmetal-800 border border-ops-700 rounded shadow-xl py-1 w-32 flex flex-col"
            style={{ top: folderContextMenu.y, left: folderContextMenu.x }}
          >
            <button 
              className="px-3 py-2 text-xs text-left hover:bg-zinc-700 flex items-center gap-2"
              onClick={() => handleRenameFolder(folderContextMenu.folderId, folderContextMenu.folderName)}
            >
              <Edit2 size={12} /> Rename
            </button>
            <button 
              className="px-3 py-2 text-xs text-left hover:bg-red-500/20 text-red-400 flex items-center gap-2"
              onClick={() => handleDeleteFolder(folderContextMenu.folderId)}
            >
              <Trash2 size={12} /> Delete
            </button>
          </div>
        </>
      )}

      {/* Masonry Grid Layout */}
      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar bg-zinc-950/30">
        {filteredNotes.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-zinc-500 space-y-2">
            <Search size={32} className="opacity-20" />
            <div className="text-xs">No notes found</div>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 items-start">
            {filteredNotes.map(note => (
              <div 
                key={note.id}
                onClick={() => openEditor(note)}
                className="bg-zinc-800 hover:bg-zinc-700/80 rounded-xl p-4 flex flex-col cursor-pointer transition-all min-h-32 shadow-sm"
              >
                <div className="font-bold text-slate-200 text-sm mb-2 break-words">{note.title || "Untitled"}</div>
                <div className="text-xs text-zinc-400 leading-relaxed line-clamp-4 mb-3 break-words whitespace-pre-wrap">
                  {note.content || "Empty note"}
                </div>
                <div className="mt-auto flex items-center text-[10px] text-zinc-500 font-semibold tracking-wider">
                  {formatNoteDate(note.updated_at)}
                  {note.is_pinned && <Pin size={10} className="ml-1 text-cyan-500 fill-cyan-500" />}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Floating Action Button */}
      <button 
        onClick={() => openEditor()}
        className="absolute bottom-6 right-6 w-14 h-14 bg-cyan-600 hover:bg-cyan-500 rounded-full shadow-[0_4px_20px_rgba(8,145,178,0.4)] flex items-center justify-center text-white transition-all transform hover:scale-105 active:scale-95 z-40"
      >
        <Plus size={28} />
      </button>

      {/* Editor Modal */}
      {isEditorOpen && (
        <div className="absolute inset-0 z-50 bg-gunmetal-900 flex flex-col animate-in fade-in slide-in-from-bottom-4 duration-200">
          {/* Editor Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-ops-700 shrink-0">
            <button onClick={() => setIsEditorOpen(false)} className="btn-ghost p-2 text-zinc-400 hover:text-slate-200">
              <X size={20} />
            </button>
            <div className="flex items-center gap-2">
              <button 
                onClick={() => setEditorIsPinned(!editorIsPinned)} 
                className={`btn-ghost p-2 ${editorIsPinned ? "text-cyan-400" : "text-zinc-500 hover:text-slate-200"}`}
                title="Pin Note"
              >
                <Pin size={18} className={editorIsPinned ? "fill-cyan-400" : ""} />
              </button>
              {editingNote && (
                <button onClick={() => handleDeleteNote(editingNote.id)} className="btn-ghost p-2 text-red-400/70 hover:text-red-400">
                  <Trash2 size={18} />
                </button>
              )}
              <button onClick={saveNote} className="btn-primary flex items-center gap-1 py-1.5 px-3 text-xs ml-2">
                <Check size={14} /> SAVE
              </button>
            </div>
          </div>
          
          {/* Editor Content */}
          <div className="flex-1 flex flex-col p-6 max-w-4xl mx-auto w-full overflow-hidden">
            <div className="flex items-center mb-4 shrink-0 relative w-max text-ops-500 hover:text-blue-active">
              <Folder size={14} className="text-zinc-500 mr-2 shrink-0" />
              <div className="relative flex items-center cursor-pointer" onClick={() => setIsFolderSelectOpen(!isFolderSelectOpen)}>
                <span className="text-xs mr-1 whitespace-pre">{editorFolderId ? folders.find(f => f.id === editorFolderId)?.name || "All Notes" : "All Notes"}</span>
                <ChevronDown size={12} className="shrink-0" />
                
                {isFolderSelectOpen && (
                  <>
                    <div className="fixed inset-0 z-40 cursor-default" onClick={(e) => { e.stopPropagation(); setIsFolderSelectOpen(false); }}></div>
                    <div className="absolute top-full left-0 mt-1 z-50 bg-gunmetal-800 border border-ops-700 rounded shadow-xl py-1 min-w-[150px] max-h-48 overflow-y-auto custom-scrollbar cursor-default" onClick={(e) => e.stopPropagation()}>
                      <button 
                        className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-zinc-700 hover:text-white"
                        onClick={() => { setEditorFolderId(null); setIsFolderSelectOpen(false); }}
                      >
                        All Notes
                      </button>
                      {folders.map(f => (
                        <button 
                          key={f.id}
                          className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-zinc-700 hover:text-white truncate"
                          onClick={() => { setEditorFolderId(f.id); setIsFolderSelectOpen(false); }}
                        >
                          {f.name}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
            
            <input
              type="text"
              placeholder="Title"
              value={editorTitle}
              onChange={e => setEditorTitle(e.target.value)}
              className="bg-transparent border-none text-2xl font-bold text-slate-100 placeholder:text-zinc-600 focus:outline-none focus:ring-0 px-0 mb-2 shrink-0"
            />
            
            <div className="flex items-center text-xs text-zinc-500 mb-4 px-1 gap-3 shrink-0 font-mono">
              <span>{(() => {
                const d = editingNote ? new Date(editingNote.updated_at * 1000) : new Date();
                const day = d.getDate();
                const month = d.toLocaleString('default', { month: 'long' });
                const year = d.getFullYear();
                const hours = d.getHours().toString().padStart(2, '0');
                const minutes = d.getMinutes().toString().padStart(2, '0');
                return `${day} ${month} ${year} ${hours}:${minutes}`;
              })()}</span>
              <span>|</span>
              <span>{editorContent.replace(/\s/g, '').length} Characters</span>
            </div>
            
            <textarea
              placeholder="Start typing..."
              value={editorContent}
              onChange={e => setEditorContent(e.target.value)}
              className="flex-1 bg-transparent border-none text-sm text-slate-300 placeholder:text-zinc-600 focus:outline-none focus:ring-0 px-0 resize-none custom-scrollbar leading-relaxed"
            />
          </div>
        </div>
      )}

      <InputDialog 
        isOpen={inputDialog.isOpen} 
        title={inputDialog.title} 
        initialValue={inputDialog.initialValue} 
        onConfirm={inputDialog.onConfirm} 
        onClose={() => setInputDialog({ ...inputDialog, isOpen: false })} 
      />

      <ConfirmDialog 
        isOpen={confirmDialog.isOpen} 
        title={confirmDialog.title} 
        message={confirmDialog.message} 
        onConfirm={confirmDialog.onConfirm} 
        onClose={() => setConfirmDialog({ ...confirmDialog, isOpen: false })} 
      />
    </div>
  );
};

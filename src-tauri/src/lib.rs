//! # lib.rs — Blacksite Node Tauri Command Surface

mod crypto;
mod security;
mod state;
mod wordlists;
mod stego;

use state::{AppState, Session, VaultState, VaultStatus};
use crate::crypto::{
    create_duress_blob, decrypt_vault, derive_key, encrypt_vault,
    generate_salt, generate_secure_password, read_duress_blob, read_vault_salt,
    try_decrypt_duress, vault_exists, wipe_vault, CredentialEntry, NoteFolder, PasswordHistoryEntry, SecureNote, VaultData,
};
use tauri::{Manager, State};
use tokio::sync::Mutex;
use std::time::SystemTime;
use rand::{rngs::OsRng, RngCore};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri::AppHandle;

struct MlEngineState {
    child: Mutex<Option<CommandChild>>,
    rx: Mutex<Option<tauri::async_runtime::Receiver<CommandEvent>>>,
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct MlScoreResult {
    pub label: String,
    pub nll: f64,
    pub color_hint: String,
    pub char_count: usize,
}

#[tauri::command]
async fn check_password_strength(app: AppHandle, password: String, state: State<'_, MlEngineState>) -> Result<MlScoreResult, String> {
    if password.is_empty() {
        return Ok(MlScoreResult {
            label: "NONE".to_string(),
            nll: 0.0,
            color_hint: "bg-ops-700".to_string(),
            char_count: 0,
        });
    }

    let mut child_guard = state.child.lock().await;
    let mut rx_guard = state.rx.lock().await;

    // Lazy initialization of the daemon sidecar
    if child_guard.is_none() {
        use tauri::path::BaseDirectory;
        let resolve_res = |dev: &str, prod: &str| -> Result<std::path::PathBuf, String> {
            let exe_dir = std::env::current_exe().map_err(|e| e.to_string())?.parent().unwrap().to_path_buf();
            
            // In dev (cargo run): target/debug -> ../../ -> workspace root
            let dev_path = exe_dir.join("..").join("..").join(dev.replace("../", ""));
            // In prod: next to executable
            let prod_path = exe_dir.join(prod.replace("_up_/", "_up_\\").replace("/", "\\"));
            
            if dev_path.exists() { return Ok(dev_path); }
            if prod_path.exists() { return Ok(prod_path); }

            // fallback to Tauri's resolve
            if let Ok(p) = app.path().resolve(dev, BaseDirectory::Resource) {
                if p.exists() { return Ok(p); }
            }
            if let Ok(p) = app.path().resolve(prod, BaseDirectory::Resource) {
                if p.exists() { return Ok(p); }
            }
            Err(format!("Resource not found: {} | Checked: {:?} and {:?}", dev, dev_path, prod_path))
        };
        let model_path = resolve_res("../ml_engine/exports/password_model.onnx", "_up_/ml_engine/exports/password_model.onnx")?;
        let vocab_path = resolve_res("../ml_engine/exports/vocab.json", "_up_/ml_engine/exports/vocab.json")?;
        let meta_path = resolve_res("../ml_engine/exports/dataset_meta.json", "_up_/ml_engine/exports/dataset_meta.json")?;

        let sidecar_command = app.shell().sidecar("inference")
            .map_err(|e| format!("Failed to create sidecar command: {}", e))?
            .arg("--model").arg(model_path)
            .arg("--vocab").arg(vocab_path)
            .arg("--meta").arg(meta_path)
            .arg("--daemon");

        let (rx, child) = sidecar_command.spawn()
            .map_err(|e| format!("Failed to spawn daemon: {}", e))?;
        
        *child_guard = Some(child);
        *rx_guard = Some(rx);

        // Wait for "READY" signal from the daemon to ensure it's fully loaded
        if let Some(rx) = rx_guard.as_mut() {
            while let Some(event) = rx.recv().await {
                if let CommandEvent::Stdout(line) = event {
                    let out_str = String::from_utf8_lossy(&line);
                    if out_str.trim().contains("READY") {
                        break; // Daemon is fully loaded and ready
                    }
                }
            }
        }
    }

    // Now write to it
    if let Some(child) = child_guard.as_mut() {
        // Simple JSON escape
        let escaped_password = password.replace("\\", "\\\\").replace("\"", "\\\"");
        let payload = format!("{{\"password\": \"{}\"}}\n", escaped_password);
        child.write(payload.as_bytes()).map_err(|e| format!("Failed to write to daemon: {}", e))?;
    }

    // Read the response
    if let Some(rx) = rx_guard.as_mut() {
        while let Some(event) = rx.recv().await {
            if let CommandEvent::Stdout(line) = event {
                let out_str = String::from_utf8_lossy(&line);
                let json_str = out_str.trim();
                // Ensure we capture the exact JSON output line
                if json_str.starts_with('{') && json_str.ends_with('}') {
                    let result: MlScoreResult = serde_json::from_str(json_str)
                        .map_err(|e| format!("Failed to parse ML output: {}", e))?;
                    return Ok(result);
                }
            } else if let CommandEvent::Stderr(line) = event {
                let err_str = String::from_utf8_lossy(&line);
                eprintln!("ML Daemon Stderr: {}", err_str);
            }
        }
    }

    Err("ML Daemon closed unexpectedly".to_string())
}
// ---------------------------------------------------------------------------
// setup_vault
// ---------------------------------------------------------------------------

/// Initializes a new vault from a frontend-provided master + canary passphrase.
///
/// The frontend generates both passphrases via `generate_passphrase()` and
/// presents them to the user before calling this command. This ensures the user
/// has recorded their passphrases BEFORE the vault is committed to disk.
///
/// Returns `Ok(())`. Both passphrases are caller-provided and never stored.
#[tauri::command]
async fn setup_vault(
    passphrase: String,
    canary_passphrase: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let mut app_state = state.lock().await;

    if vault_exists(&app_state.vault_path) {
        return Err("Vault already exists. Use unlock_vault to access it.".to_string());
    }

    let master_salt = generate_salt();
    let canary_salt = generate_salt();

    let passphrase_clone = passphrase.clone();
    let canary_clone = canary_passphrase.clone();
    let key_result = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let master_key = derive_key(&passphrase_clone, &master_salt)?;
        let duress_blob = create_duress_blob(&canary_clone, &canary_salt)?;
        Ok((master_key, master_salt, duress_blob))
    })
    .await
    .map_err(|e| format!("KDF task error: {e}"))?;

    let (master_key, master_salt, duress_blob) = key_result?;

    let vault_data = VaultData { version: 1, entries: Vec::new(), note_folders: Vec::new(), notes: Vec::new() };
    encrypt_vault(&vault_data, &master_key, &app_state.vault_path, &master_salt, Some(&duress_blob))?;

    app_state.duress_blob = Some(duress_blob);
    app_state.session = Some(Session { master_key, vault_data, is_duress: false });

    Ok(())
}

// ---------------------------------------------------------------------------
// get_vault_status
// ---------------------------------------------------------------------------

#[tauri::command]
async fn get_vault_status(state: State<'_, VaultState>) -> Result<VaultStatus, String> {
    let app_state = state.lock().await;
    let exists = vault_exists(&app_state.vault_path);
    let mut is_corrupted = false;

    if exists {
        if let Ok(content) = std::fs::read_to_string(&app_state.vault_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if json.get("magic").and_then(|v| v.as_str()) != Some("BLACKSITE_NODE_v1") {
                    is_corrupted = true;
                }
            } else {
                is_corrupted = true;
            }
        } else {
            is_corrupted = true;
        }
    }

    Ok(VaultStatus {
        vault_exists: exists,
        is_unlocked: app_state.is_unlocked(),
        failed_attempts: app_state.rate_limiter.failed_count(),
        lockout_remaining_secs: app_state.rate_limiter.remaining_lockout_secs(),
        is_corrupted,
    })
}

// ---------------------------------------------------------------------------
// unlock_vault
// ---------------------------------------------------------------------------

/// Attempts to unlock the vault.
///
/// ## Duress Protocol
/// If the entered passphrase is the canary key (not the master key), the backend:
/// 1. Overwrites the vault file with zeros and deletes it.
/// 2. Opens an in-memory empty session flagged as `is_duress = true`.
/// 3. Returns `Ok(())` — identical to a successful normal unlock.
///
/// The frontend sees no difference. Subsequent reads return zero credentials;
/// writes are silently discarded. On next launch the vault appears uninitialized.
#[tauri::command]
async fn unlock_vault(
    passphrase: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    // Check lockout before doing any crypto work
    {
        let app_state = state.lock().await;
        if let Err(remaining) = app_state.rate_limiter.check_lockout() {
            return Err(format!("LOCKED:{remaining}"));
        }
        if !vault_exists(&app_state.vault_path) {
            return Err("No vault found. Run setup first.".to_string());
        }
    }

    let vault_path = {
        let app_state = state.lock().await;
        app_state.vault_path.clone()
    };

    let salt = read_vault_salt(&vault_path)?;

    // Attempt to derive a key and decrypt with the master ciphertext
    let passphrase_for_master = passphrase.clone();
    let salt_clone = salt.clone();
    let master_key_result = tokio::task::spawn_blocking(move || {
        derive_key(&passphrase_for_master, &salt_clone)
    })
    .await
    .map_err(|e| format!("KDF task error: {e}"))?;

    match master_key_result {
        Ok(master_key) => {
            match decrypt_vault(&master_key, &vault_path) {
                Ok(vault_data) => {
                    // Master key success — read duress blob and open real session
                    let duress_blob = read_duress_blob(&vault_path);
                    let mut app_state = state.lock().await;
                    app_state.rate_limiter.record_success();
                    app_state.duress_blob = duress_blob;
                    app_state.session = Some(Session { master_key, vault_data, is_duress: false });
                    Ok(())
                }
                Err(_) => {
                    // Master decrypt failed. Try the duress path before recording failure.
                    let vp = vault_path.clone();
                    let p2 = passphrase.clone();
                    let duress_check = tokio::task::spawn_blocking(move || {
                        try_decrypt_duress(&p2, &vp)
                    })
                    .await
                    .map_err(|e| format!("Duress check error: {e}"))?;

                    match duress_check {
                        Ok(true) => {
                            // Canary key confirmed — wipe vault and open ghost session
                            wipe_vault(&vault_path)?;
                            let mut app_state = state.lock().await;
                            app_state.rate_limiter.record_success();
                            app_state.duress_blob = None;
                            app_state.session = Some(Session {
                                master_key,
                                vault_data: VaultData { version: 1, entries: Vec::new(), note_folders: Vec::new(), notes: Vec::new() },
                                is_duress: true,
                            });
                            Ok(())
                        }
                        _ => {
                            // Neither master nor canary — genuine wrong passphrase
                            let mut app_state = state.lock().await;
                            app_state.rate_limiter.record_failure();
                            let remaining = app_state.rate_limiter.remaining_lockout_secs();
                            if remaining > 0 {
                                Err(format!("LOCKED:{remaining}"))
                            } else {
                                Err("WRONG_PASSPHRASE".to_string())
                            }
                        }
                    }
                }
            }
        }
        Err(e) => Err(format!("Key derivation error: {e}")),
    }
}

// ---------------------------------------------------------------------------
// lock_vault
// ---------------------------------------------------------------------------

#[tauri::command]
async fn lock_vault(state: State<'_, VaultState>) -> Result<(), String> {
    let mut app_state = state.lock().await;
    app_state.lock();
    Ok(())
}

// ---------------------------------------------------------------------------
// get_credentials
// ---------------------------------------------------------------------------

#[tauri::command]
async fn get_credentials(state: State<'_, VaultState>) -> Result<Vec<CredentialEntry>, String> {
    let app_state = state.lock().await;
    match &app_state.session {
        Some(session) => Ok(session.vault_data.entries.clone()),
        None => Err("Vault is locked.".to_string()),
    }
}

// ---------------------------------------------------------------------------
// add_credential
// ---------------------------------------------------------------------------

#[tauri::command]
async fn add_credential(
    service: String,
    username: String,
    password: String,
    notes: String,
    category: Option<String>,
    state: State<'_, VaultState>,
) -> Result<String, String> {
    let mut app_state = state.lock().await;

    let session = app_state.session.as_mut().ok_or("Vault is locked.")?;

    // In a duress session the vault file is gone — silently succeed
    if session.is_duress {
        let mut id_bytes = [0u8; 16];
        OsRng.fill_bytes(&mut id_bytes);
        return Ok(hex::encode(id_bytes));
    }

    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let mut id_bytes = [0u8; 16];
    OsRng.fill_bytes(&mut id_bytes);
    let id = hex::encode(id_bytes);

    let entry = CredentialEntry {
        id: id.clone(),
        service,
        username,
        password,
        notes,
        created_at: now,
        updated_at: now,
        password_history: Vec::new(),
        category,
    };

    session.vault_data.entries.push(entry);

    let salt_bytes = read_vault_salt(&app_state.vault_path)?;
    let mut salt_arr = [0u8; 16];
    let copy_len = salt_bytes.len().min(16);
    salt_arr[..copy_len].copy_from_slice(&salt_bytes[..copy_len]);

    let duress_blob = app_state.duress_blob.clone();
    let session = app_state.session.as_ref().ok_or("Vault is locked.")?;
    encrypt_vault(
        &session.vault_data,
        &session.master_key,
        &app_state.vault_path,
        &salt_arr,
        duress_blob.as_ref(),
    )?;

    Ok(id)
}

// ---------------------------------------------------------------------------
// delete_credential
// ---------------------------------------------------------------------------

#[tauri::command]
async fn delete_credential(id: String, state: State<'_, VaultState>) -> Result<(), String> {
    let mut app_state = state.lock().await;

    let session = app_state.session.as_mut().ok_or("Vault is locked.")?;

    if session.is_duress {
        return Ok(());
    }

    let before = session.vault_data.entries.len();
    session.vault_data.entries.retain(|e| e.id != id);
    if session.vault_data.entries.len() == before {
        return Err("Entry not found.".to_string());
    }

    let salt_bytes = read_vault_salt(&app_state.vault_path)?;
    let mut salt_arr = [0u8; 16];
    let copy_len = salt_bytes.len().min(16);
    salt_arr[..copy_len].copy_from_slice(&salt_bytes[..copy_len]);

    let duress_blob = app_state.duress_blob.clone();
    let session = app_state.session.as_ref().ok_or("Vault is locked.")?;
    encrypt_vault(
        &session.vault_data,
        &session.master_key,
        &app_state.vault_path,
        &salt_arr,
        duress_blob.as_ref(),
    )?;

    Ok(())
}


// ---------------------------------------------------------------------------
// edit_credential
// ---------------------------------------------------------------------------

#[tauri::command]
async fn edit_credential(
    id: String,
    service: String,
    username: String,
    password: String,
    notes: String,
    category: Option<String>,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let mut app_state = state.lock().await;

    let session = app_state.session.as_mut().ok_or("Vault is locked.")?;

    if session.is_duress {
        return Ok(());
    }

    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let entry = session.vault_data.entries.iter_mut().find(|e| e.id == id).ok_or("Entry not found.")?;

    if entry.password != password {
        entry.password_history.push(PasswordHistoryEntry {
            password: entry.password.clone(),
            changed_at: now,
        });
    }

    entry.service = service;
    entry.username = username;
    entry.password = password;
    entry.notes = notes;
    entry.category = category;
    entry.updated_at = now;

    let salt_bytes = read_vault_salt(&app_state.vault_path)?;
    let mut salt_arr = [0u8; 16];
    let copy_len = salt_bytes.len().min(16);
    salt_arr[..copy_len].copy_from_slice(&salt_bytes[..copy_len]);

    let duress_blob = app_state.duress_blob.clone();
    let session = app_state.session.as_ref().ok_or("Vault is locked.")?;
    encrypt_vault(
        &session.vault_data,
        &session.master_key,
        &app_state.vault_path,
        &salt_arr,
        duress_blob.as_ref(),
    )?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Secure Notes IPC Commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn get_notes(state: State<'_, VaultState>) -> Result<Vec<SecureNote>, String> {
    let app_state = state.lock().await;
    match &app_state.session {
        Some(session) => Ok(session.vault_data.notes.clone()),
        None => Err("Vault is locked.".to_string()),
    }
}

#[tauri::command]
async fn add_note(
    title: String,
    content: String,
    folder_id: Option<String>,
    is_pinned: bool,
    state: State<'_, VaultState>,
) -> Result<String, String> {
    let mut app_state = state.lock().await;
    let session = app_state.session.as_mut().ok_or("Vault is locked.")?;

    if session.is_duress {
        let mut id_bytes = [0u8; 16];
        OsRng.fill_bytes(&mut id_bytes);
        return Ok(hex::encode(id_bytes));
    }

    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs();
    let mut id_bytes = [0u8; 16];
    OsRng.fill_bytes(&mut id_bytes);
    let id = hex::encode(id_bytes);

    let note = SecureNote {
        id: id.clone(),
        title,
        content,
        folder_id,
        is_pinned,
        created_at: now,
        updated_at: now,
    };

    session.vault_data.notes.push(note);

    let salt_bytes = read_vault_salt(&app_state.vault_path)?;
    let mut salt_arr = [0u8; 16];
    let copy_len = salt_bytes.len().min(16);
    salt_arr[..copy_len].copy_from_slice(&salt_bytes[..copy_len]);

    let duress_blob = app_state.duress_blob.clone();
    let session = app_state.session.as_ref().ok_or("Vault is locked.")?;
    encrypt_vault(&session.vault_data, &session.master_key, &app_state.vault_path, &salt_arr, duress_blob.as_ref())?;

    Ok(id)
}

#[tauri::command]
async fn edit_note(
    id: String,
    title: String,
    content: String,
    folder_id: Option<String>,
    is_pinned: bool,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let mut app_state = state.lock().await;
    let session = app_state.session.as_mut().ok_or("Vault is locked.")?;

    if session.is_duress { return Ok(()); }

    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs();

    if let Some(note) = session.vault_data.notes.iter_mut().find(|n| n.id == id) {
        note.title = title;
        note.content = content;
        note.folder_id = folder_id;
        note.is_pinned = is_pinned;
        note.updated_at = now;
    } else {
        return Err("Note not found".to_string());
    }

    let salt_bytes = read_vault_salt(&app_state.vault_path)?;
    let mut salt_arr = [0u8; 16];
    let copy_len = salt_bytes.len().min(16);
    salt_arr[..copy_len].copy_from_slice(&salt_bytes[..copy_len]);

    let duress_blob = app_state.duress_blob.clone();
    let session = app_state.session.as_ref().ok_or("Vault is locked.")?;
    encrypt_vault(&session.vault_data, &session.master_key, &app_state.vault_path, &salt_arr, duress_blob.as_ref())?;

    Ok(())
}

#[tauri::command]
async fn delete_note(id: String, state: State<'_, VaultState>) -> Result<(), String> {
    let mut app_state = state.lock().await;
    let session = app_state.session.as_mut().ok_or("Vault is locked.")?;

    if session.is_duress { return Ok(()); }

    session.vault_data.notes.retain(|n| n.id != id);

    let salt_bytes = read_vault_salt(&app_state.vault_path)?;
    let mut salt_arr = [0u8; 16];
    let copy_len = salt_bytes.len().min(16);
    salt_arr[..copy_len].copy_from_slice(&salt_bytes[..copy_len]);

    let duress_blob = app_state.duress_blob.clone();
    let session = app_state.session.as_ref().ok_or("Vault is locked.")?;
    encrypt_vault(&session.vault_data, &session.master_key, &app_state.vault_path, &salt_arr, duress_blob.as_ref())?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Note Folders IPC Commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn get_note_folders(state: State<'_, VaultState>) -> Result<Vec<NoteFolder>, String> {
    let app_state = state.lock().await;
    match &app_state.session {
        Some(session) => Ok(session.vault_data.note_folders.clone()),
        None => Err("Vault is locked.".to_string()),
    }
}

#[tauri::command]
async fn add_note_folder(name: String, state: State<'_, VaultState>) -> Result<String, String> {
    let mut app_state = state.lock().await;
    let session = app_state.session.as_mut().ok_or("Vault is locked.")?;

    if session.is_duress {
        let mut id_bytes = [0u8; 16];
        OsRng.fill_bytes(&mut id_bytes);
        return Ok(hex::encode(id_bytes));
    }

    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs();
    let mut id_bytes = [0u8; 16];
    OsRng.fill_bytes(&mut id_bytes);
    let id = hex::encode(id_bytes);

    let folder = NoteFolder { id: id.clone(), name, created_at: now };
    session.vault_data.note_folders.push(folder);

    let salt_bytes = read_vault_salt(&app_state.vault_path)?;
    let mut salt_arr = [0u8; 16];
    let copy_len = salt_bytes.len().min(16);
    salt_arr[..copy_len].copy_from_slice(&salt_bytes[..copy_len]);

    let duress_blob = app_state.duress_blob.clone();
    let session = app_state.session.as_ref().ok_or("Vault is locked.")?;
    encrypt_vault(&session.vault_data, &session.master_key, &app_state.vault_path, &salt_arr, duress_blob.as_ref())?;

    Ok(id)
}

#[tauri::command]
async fn edit_note_folder(id: String, name: String, state: State<'_, VaultState>) -> Result<(), String> {
    let mut app_state = state.lock().await;
    let session = app_state.session.as_mut().ok_or("Vault is locked.")?;

    if session.is_duress { return Ok(()); }

    if let Some(folder) = session.vault_data.note_folders.iter_mut().find(|f| f.id == id) {
        folder.name = name;
    } else {
        return Err("Folder not found".to_string());
    }

    let salt_bytes = read_vault_salt(&app_state.vault_path)?;
    let mut salt_arr = [0u8; 16];
    let copy_len = salt_bytes.len().min(16);
    salt_arr[..copy_len].copy_from_slice(&salt_bytes[..copy_len]);

    let duress_blob = app_state.duress_blob.clone();
    let session = app_state.session.as_ref().ok_or("Vault is locked.")?;
    encrypt_vault(&session.vault_data, &session.master_key, &app_state.vault_path, &salt_arr, duress_blob.as_ref())?;

    Ok(())
}

#[tauri::command]
async fn delete_note_folder(id: String, state: State<'_, VaultState>) -> Result<(), String> {
    let mut app_state = state.lock().await;
    let session = app_state.session.as_mut().ok_or("Vault is locked.")?;

    if session.is_duress { return Ok(()); }

    session.vault_data.note_folders.retain(|f| f.id != id);
    // Also remove folder_id from any notes that were in this folder
    for note in session.vault_data.notes.iter_mut() {
        if note.folder_id.as_deref() == Some(id.as_str()) {
            note.folder_id = None;
        }
    }

    let salt_bytes = read_vault_salt(&app_state.vault_path)?;
    let mut salt_arr = [0u8; 16];
    let copy_len = salt_bytes.len().min(16);
    salt_arr[..copy_len].copy_from_slice(&salt_bytes[..copy_len]);

    let duress_blob = app_state.duress_blob.clone();
    let session = app_state.session.as_ref().ok_or("Vault is locked.")?;
    encrypt_vault(&session.vault_data, &session.master_key, &app_state.vault_path, &salt_arr, duress_blob.as_ref())?;

    Ok(())
}

// ---------------------------------------------------------------------------
// delete_history_entry

// ---------------------------------------------------------------------------

#[tauri::command]
async fn delete_history_entry(
    id: String,
    changed_at: u64,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let mut app_state = state.lock().await;
    let session = app_state.session.as_mut().ok_or("Vault is locked.")?;
    if session.is_duress {
        return Ok(());
    }
    
    let entry = session.vault_data.entries.iter_mut().find(|e| e.id == id).ok_or("Entry not found.")?;
    entry.password_history.retain(|h| h.changed_at != changed_at);

    let salt_bytes = read_vault_salt(&app_state.vault_path)?;
    let mut salt_arr = [0u8; 16];
    let copy_len = salt_bytes.len().min(16);
    salt_arr[..copy_len].copy_from_slice(&salt_bytes[..copy_len]);

    let duress_blob = app_state.duress_blob.clone();
    let session = app_state.session.as_ref().ok_or("Vault is locked.")?;
    encrypt_vault(
        &session.vault_data,
        &session.master_key,
        &app_state.vault_path,
        &salt_arr,
        duress_blob.as_ref(),
    )?;

    Ok(())
}

// ---------------------------------------------------------------------------
// generate_passphrase
// ---------------------------------------------------------------------------

#[tauri::command]
async fn generate_passphrase(word_count: usize, languages: Vec<String>) -> Result<String, String> {
    Ok(crate::crypto::generate_diceware_passphrase(word_count, &languages))
}

// ---------------------------------------------------------------------------
// cmd_generate_secure_password
// ---------------------------------------------------------------------------

#[tauri::command]
async fn cmd_generate_secure_password(length: Option<usize>) -> Result<String, String> {
    let len = length.unwrap_or(24).clamp(12, 128);
    Ok(generate_secure_password(len))
}


// ---------------------------------------------------------------------------
// get_app_version
// ---------------------------------------------------------------------------

#[tauri::command]
async fn get_app_version() -> Result<String, String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

// ---------------------------------------------------------------------------
// export_vault
// ---------------------------------------------------------------------------

#[tauri::command]
async fn export_vault(export_path: String, state: State<'_, VaultState>) -> Result<(), String> {
    let app_state = state.lock().await;
    let session = app_state.session.as_ref().ok_or("Vault is locked.")?;
    
    if session.is_duress {
        return Err("Cannot export from a duress session.".to_string());
    }

    let salt_bytes = crate::crypto::read_vault_salt(&app_state.vault_path)
        .map_err(|e| format!("Could not read current vault salt: {}", e))?;
    let mut salt = [0u8; 16];
    let copy_len = salt_bytes.len().min(16);
    salt[..copy_len].copy_from_slice(&salt_bytes[..copy_len]);

    encrypt_vault(
        &session.vault_data,
        &session.master_key,
        &std::path::PathBuf::from(export_path),
        &salt,
        None, // No duress blob in exported file
    )?;
    
    Ok(())
}

// ---------------------------------------------------------------------------
// export_stego_vault
// ---------------------------------------------------------------------------

#[tauri::command]
async fn export_stego_vault(
    carrier_path: String,
    dest_path: String,
    mode: String, // "eof" or "lsb"
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let app_state = state.lock().await;
    let session = app_state.session.as_ref().ok_or("Vault is locked.")?;
    
    if session.is_duress {
        return Err("Cannot export from a duress session.".to_string());
    }

    let temp_dir = std::env::temp_dir();
    let temp_path = temp_dir.join(format!("blacksite_stego_{}.tmp", rand::random::<u32>()));
    
    let salt_bytes = crate::crypto::read_vault_salt(&app_state.vault_path)
        .map_err(|e| format!("Could not read current vault salt: {}", e))?;
    let mut salt = [0u8; 16];
    let copy_len = salt_bytes.len().min(16);
    salt[..copy_len].copy_from_slice(&salt_bytes[..copy_len]);

    encrypt_vault(
        &session.vault_data,
        &session.master_key,
        &temp_path,
        &salt,
        None,
    )?;

    let payload = std::fs::read(&temp_path).map_err(|e| format!("Failed to read temp vault: {}", e))?;
    let _ = std::fs::remove_file(&temp_path);

    let carrier = std::path::PathBuf::from(carrier_path);
    let dest = std::path::PathBuf::from(dest_path);

    if mode == "lsb" {
        crate::stego::embed_lsb(&carrier, &dest, &payload).map_err(|e| format!("LSB Steganography failed: {}", e))?;
    } else {
        crate::stego::embed_eof(&carrier, &dest, &payload).map_err(|e| format!("EOF Steganography failed: {}", e))?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// import_vault
// ---------------------------------------------------------------------------

#[tauri::command]
async fn import_vault(
    import_path: String,
    old_passphrase: String,
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let path = std::path::PathBuf::from(import_path);
    if !vault_exists(&path) {
        return Err("Export file not found.".to_string());
    }

    let salt = read_vault_salt(&path)?;
    let old_key = derive_key(&old_passphrase, &salt)?;
    let imported_vault = decrypt_vault(&old_key, &path)?;

    let mut app_state = state.lock().await;
    let session = app_state.session.as_mut().ok_or("Vault is locked.")?;
    
    if session.is_duress {
        return Err("Cannot import into a duress session.".to_string());
    }

    // Merge entries
    for mut imported_entry in imported_vault.entries.clone() {
        let mut id_bytes = [0u8; 16];
        OsRng.fill_bytes(&mut id_bytes);
        imported_entry.id = hex::encode(id_bytes);
        session.vault_data.entries.push(imported_entry);
    }

    // Merge Note Folders
    let mut folder_id_map = std::collections::HashMap::new();
    for mut imported_folder in imported_vault.note_folders.clone() {
        let mut id_bytes = [0u8; 16];
        OsRng.fill_bytes(&mut id_bytes);
        let new_id = hex::encode(id_bytes);
        folder_id_map.insert(imported_folder.id.clone(), new_id.clone());
        imported_folder.id = new_id;
        session.vault_data.note_folders.push(imported_folder);
    }

    // Merge Notes
    for mut imported_note in imported_vault.notes.clone() {
        let mut id_bytes = [0u8; 16];
        OsRng.fill_bytes(&mut id_bytes);
        imported_note.id = hex::encode(id_bytes);
        
        if let Some(old_f_id) = &imported_note.folder_id {
            if let Some(new_f_id) = folder_id_map.get(old_f_id) {
                imported_note.folder_id = Some(new_f_id.clone());
            } else {
                imported_note.folder_id = None;
            }
        }
        session.vault_data.notes.push(imported_note);
    }

    // Re-encrypt the current vault
    let salt_bytes = read_vault_salt(&app_state.vault_path)?;
    let mut salt_arr = [0u8; 16];
    let copy_len = salt_bytes.len().min(16);
    salt_arr[..copy_len].copy_from_slice(&salt_bytes[..copy_len]);

    let duress_blob = app_state.duress_blob.clone();
    let session = app_state.session.as_ref().unwrap();
    encrypt_vault(
        &session.vault_data,
        &session.master_key,
        &app_state.vault_path,
        &salt_arr,
        duress_blob.as_ref(),
    )?;

    Ok(())
}

// ---------------------------------------------------------------------------
// secure_copy
// ---------------------------------------------------------------------------

#[tauri::command]
async fn secure_copy(text: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        if text.is_empty() {
            if let Ok(_clip) = clipboard_win::Clipboard::new_attempts(10) {
                let _ = clipboard_win::raw::empty();
            }
        } else {
            let _ = clipboard_win::set_clipboard_string(&text);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Secure copy is only implemented on Windows.".to_string())
    }
}

// ---------------------------------------------------------------------------
// import_stego_vault
// ---------------------------------------------------------------------------

#[tauri::command]
async fn import_stego_vault(
    source_path: String,
    old_passphrase: String,
    mode: String, // "eof" or "lsb"
    state: State<'_, VaultState>,
) -> Result<(), String> {
    let source = std::path::PathBuf::from(&source_path);

    let payload = if mode == "lsb" {
        crate::stego::extract_lsb(&source).map_err(|e| format!("LSB Extraction failed: {}", e))?
    } else {
        crate::stego::extract_eof(&source).map_err(|e| format!("EOF Extraction failed: {}", e))?
    };

    let temp_dir = std::env::temp_dir();
    let temp_path = temp_dir.join(format!("blacksite_stego_import_{}.tmp", rand::random::<u32>()));
    std::fs::write(&temp_path, &payload).map_err(|e| format!("Failed to write temp vault: {}", e))?;

    let salt = read_vault_salt(&temp_path).map_err(|e| { let _ = std::fs::remove_file(&temp_path); e.to_string() })?;
    let old_key = derive_key(&old_passphrase, &salt).map_err(|e| { let _ = std::fs::remove_file(&temp_path); e.to_string() })?;
    let imported_vault = decrypt_vault(&old_key, &temp_path).map_err(|e| { let _ = std::fs::remove_file(&temp_path); e.to_string() })?;
    let _ = std::fs::remove_file(&temp_path);

    let mut app_state = state.lock().await;
    let vault_path = app_state.vault_path.clone();
    let duress_blob = app_state.duress_blob.clone();
    
    let session = app_state.session.as_mut().ok_or("Vault is locked.")?;
    
    if session.is_duress {
        return Err("Cannot import into a duress session.".to_string());
    }

    for mut imported_entry in imported_vault.entries.clone() {
        let mut id_bytes = [0u8; 16];
        OsRng.fill_bytes(&mut id_bytes);
        imported_entry.id = hex::encode(id_bytes);
        session.vault_data.entries.push(imported_entry);
    }

    let mut folder_id_map = std::collections::HashMap::new();
    for mut imported_folder in imported_vault.note_folders.clone() {
        let mut id_bytes = [0u8; 16];
        OsRng.fill_bytes(&mut id_bytes);
        let new_id = hex::encode(id_bytes);
        folder_id_map.insert(imported_folder.id.clone(), new_id.clone());
        imported_folder.id = new_id;
        session.vault_data.note_folders.push(imported_folder);
    }

    for mut imported_note in imported_vault.notes.clone() {
        let mut id_bytes = [0u8; 16];
        OsRng.fill_bytes(&mut id_bytes);
        imported_note.id = hex::encode(id_bytes);
        
        if let Some(old_f_id) = &imported_note.folder_id {
            if let Some(new_f_id) = folder_id_map.get(old_f_id) {
                imported_note.folder_id = Some(new_f_id.clone());
            } else {
                imported_note.folder_id = None;
            }
        }
        session.vault_data.notes.push(imported_note);
    }

    let salt_bytes = read_vault_salt(&vault_path)?;
    let mut salt_arr = [0u8; 16];
    let copy_len = salt_bytes.len().min(16);
    salt_arr[..copy_len].copy_from_slice(&salt_bytes[..copy_len]);

    encrypt_vault(
        &session.vault_data,
        &session.master_key,
        &vault_path,
        &salt_arr,
        duress_blob.as_ref(),
    )?;

    Ok(())
}

#[tauri::command]
async fn cmd_wipe_vault(state: tauri::State<'_, Mutex<AppState>>) -> Result<(), String> {
    let mut app_state = state.lock().await;
    
    // Wipe the vault file using the existing crypto function
    if app_state.vault_path.exists() {
        crate::crypto::wipe_vault(&app_state.vault_path)?;
    }
    
    // Clear the active session, duress blob, and reset the rate limiter
    app_state.session = None;
    app_state.duress_blob = None;
    app_state.rate_limiter = crate::security::RateLimiter::new();
    
    Ok(())
}

#[tauri::command]
fn cmd_restart_app(app_handle: tauri::AppHandle) {
    app_handle.restart();
}

#[tauri::command]
fn cmd_close_app(app_handle: tauri::AppHandle) {
    app_handle.exit(0);
}

// ---------------------------------------------------------------------------
// Tauri application entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to resolve app data directory");

            std::fs::create_dir_all(&data_dir)
                .expect("Failed to create app data directory");

            let vault_path = data_dir.join("vault.blacksite");

            app.manage(Mutex::new(AppState::new(vault_path)));
            app.manage(MlEngineState {
                child: Mutex::new(None),
                rx: Mutex::new(None),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_password_strength,
            setup_vault,
            get_vault_status,
            unlock_vault,
            lock_vault,
            get_credentials,
            add_credential,
            edit_credential,
            delete_credential,
            delete_history_entry,
            get_notes,
            add_note,
            edit_note,
            delete_note,
            get_note_folders,
            add_note_folder,
            edit_note_folder,
            delete_note_folder,
            generate_passphrase,
            cmd_generate_secure_password,
            get_app_version,
            export_vault,
            import_vault,
            export_stego_vault,
            import_stego_vault,
            secure_copy,
            cmd_wipe_vault,
            cmd_restart_app,
            cmd_close_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

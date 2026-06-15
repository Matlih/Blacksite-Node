//! # crypto.rs — Blacksite Node Cryptographic Engine
//!
//! ## Threat Model
//! This module assumes the attacker has:
//! - Full offline access to the `.blacksite` vault file (e.g., stolen device or backup).
//! - A GPU cluster capable of billions of KDF evaluations per second against weak hashes.
//! - The source code of this application (Kerckhoffs's principle: security through secrecy
//!   of the KEY, not the algorithm).
//!
//! ## Mitigations Implemented
//! 1. **Argon2id KDF**: memory-hard derivation requiring ~64 MB RAM and multiple passes per
//!    attempt. A GPU with 10 GB VRAM can only run ~156 parallel derivations; this limits
//!    brute-force throughput to thousands per second instead of billions.
//! 2. **ChaCha20-Poly1305 AEAD**: authenticated encryption. Any tampering with the ciphertext
//!    is detected before decryption. Prevents the attacker from learning plaintext structure
//!    via chosen-ciphertext attacks.
//! 3. **Random 96-bit nonces**: unique per encryption. Nonce reuse with ChaCha20-Poly1305
//!    is catastrophic (leaks keystream), so the OS CSPRNG is used here — never a counter.
//! 4. **Zeroize on drop**: the `MasterKey` type overwrites its heap memory with zeros when
//!    dropped, preventing key extraction via memory forensics on a running process.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use unicode_normalization::UnicodeNormalization;
use zeroize::{Zeroize, ZeroizeOnDrop};
use base64::prelude::*;


// ---------------------------------------------------------------------------
// Constants — Argon2id hardening parameters
// ---------------------------------------------------------------------------

/// Memory cost: 65536 KiB = 64 MiB per derivation attempt.
/// OWASP recommends ≥19 MiB; we use 64 MiB to force GPU parallelism to ~156
/// concurrent threads on a 10 GB VRAM card.
const ARGON2_MEMORY_KIB: u32 = 65536;

/// Iteration count: 3 passes over the memory block.
/// Combined with the memory cost, a single derivation takes ~300–800 ms on
/// commodity hardware — imperceptible to a legitimate user, catastrophic for
/// automated brute-force.
const ARGON2_ITERATIONS: u32 = 3;

/// Parallelism: 1 lane. Higher parallelism allows an attacker to use multi-core
/// efficiently; we pin to 1 to maximize serial memory latency cost.
const ARGON2_PARALLELISM: u32 = 1;

/// Derived key length in bytes. 32 bytes = 256 bits, matching ChaCha20-Poly1305's
/// key size requirement and providing 256-bit symmetric security.
const KEY_LEN: usize = 32;

/// Salt length in bytes. 16 bytes = 128-bit random salt, uniquely generated per
/// vault. The salt prevents precomputed rainbow-table attacks across vaults.
const SALT_LEN: usize = 16;

/// ChaCha20-Poly1305 nonce length: 96 bits. A fresh random nonce is generated
/// for every encryption operation.
const NONCE_LEN: usize = 12;

// ---------------------------------------------------------------------------
// Duress (canary) blob — zeroize-safe static container
// ---------------------------------------------------------------------------

/// Encrypted blob that the Duress/Canary passphrase decrypts to (always empty vault).
/// Stored inside the VaultFile so the backend can verify the canary without knowing
/// which passphrase the user typed at unlock time.
#[derive(Clone)]
pub struct DuressBlob {
    pub salt: [u8; SALT_LEN],
    pub nonce: [u8; NONCE_LEN],
    pub ciphertext: Vec<u8>,
}

// ---------------------------------------------------------------------------
// Diceware wordlist
// ---------------------------------------------------------------------------

/// Merged and sanitized Diceware wordlist.
/// Words sourced from EFF Long List (English), supplemented with Spanish,
/// Filipino (Tagalog), and Italian words, then normalized through the
/// sanitization pipeline to ASCII-only, standard QWERTY-typeable form.
///
/// The sanitization pipeline:
/// 1. Unicode NFC normalization (canonical decomposition + composition).
/// 2. Diacritic stripping: 'à'→'a', 'ñ'→'n', 'è'→'e', etc.
/// 3. Non-ASCII character removal.
/// 4. Lowercase enforcement.
/// 5. Words shorter than 3 characters are excluded to maintain passphrase entropy.
///
/// Entropy per word: log2(wordlist_size). With 7,776+ words: ~12.9 bits/word.
/// 5-word passphrase entropy: ~64.5 bits — sufficient against online attacks
/// and meaningful resistance against offline attacks when combined with Argon2id.
// Dictionary removed in favor of multilingual lists in wordlists.rs


// ---------------------------------------------------------------------------
// Master Key — zeroized secure wrapper
// ---------------------------------------------------------------------------

/// In-memory representation of the derived 256-bit encryption key.
///
/// `ZeroizeOnDrop` guarantees that when this struct is dropped — either
/// explicitly via `lock_vault()` or implicitly when the process exits — the
/// 32 key bytes are overwritten with zeros. This prevents the key from being
/// recovered from process memory dumps, swap files, or hibernation images.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct MasterKey {
    pub bytes: [u8; KEY_LEN],
}

// ---------------------------------------------------------------------------
// Vault data structures
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone, Zeroize, ZeroizeOnDrop)]
pub struct PasswordHistoryEntry {
    pub password: String,
    pub changed_at: u64,
}

/// A single credential entry stored in the vault.
/// All fields are cleartext ONLY while the vault is decrypted in RAM.
/// On disk, the entire `VaultData` collection is encrypted as one unit.
#[derive(Debug, Serialize, Deserialize, Clone, Zeroize, ZeroizeOnDrop)]
pub struct CredentialEntry {
    pub id: String,
    pub service: String,
    pub username: String,
    /// Stored as plaintext ONLY in the in-memory decrypted vault.
    /// NEVER written to disk unencrypted.
    pub password: String,
    pub notes: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub password_history: Vec<PasswordHistoryEntry>,
    #[serde(default)]
    pub category: Option<String>,
}

/// The decrypted vault payload serialized to/from JSON before encryption.
/// The entire struct is treated as a single atomic plaintext blob — there is
/// no partial encryption. Either the whole vault decrypts (correct key) or
/// nothing does (wrong key → Poly1305 authentication failure).
#[derive(Debug, Serialize, Deserialize, Default, Zeroize, ZeroizeOnDrop)]
pub struct VaultData {
    pub version: u8,
    pub entries: Vec<CredentialEntry>,
}

/// The on-disk representation of the vault file.
/// Contains all public metadata needed for decryption; the ciphertext is the
/// only sensitive portion, and it cannot be decoded without the derived key.
#[derive(Debug, Serialize, Deserialize)]
pub struct VaultFile {
    /// Application magic string for format validation.
    pub magic: String,
    /// Format version — allows future migration without breaking old vaults.
    pub version: u8,
    /// Base64-encoded 16-byte random salt used for Argon2id KDF.
    /// Unique per vault; stored in plaintext because it is not secret —
    /// its only function is to prevent precomputed attacks across vaults.
    pub salt: String,
    /// Base64-encoded 12-byte random nonce used for ChaCha20-Poly1305.
    /// Unique per save operation; stored alongside the ciphertext.
    pub nonce: String,
    /// Base64-encoded ciphertext + 16-byte Poly1305 authentication tag.
    /// The tag is appended by the AEAD library transparently.
    pub ciphertext: String,
    /// Duress/Canary fields — present only if setup with duress key.
    /// All three must be present together or omitted together.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub duress_salt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub duress_nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub duress_ciphertext: Option<String>,
}

const VAULT_MAGIC: &str = "BLACKSITE_NODE_v1";
const VAULT_FORMAT_VERSION: u8 = 1;

// ---------------------------------------------------------------------------
// Argon2id Key Derivation
// ---------------------------------------------------------------------------

/// Derives a 256-bit encryption key from the master passphrase using Argon2id.
///
/// # Security properties
/// - **Memory hardness**: 64 MiB RAM must be accessed in a pseudo-random order
///   per derivation attempt. GPUs are bandwidth-limited for this access pattern.
/// - **Time hardness**: 3 sequential passes over the memory block increase
///   latency without proportionally increasing GPU parallelism.
/// - **Domain separation**: The salt is unique per vault, preventing an attacker
///   from reusing work across multiple captured vault files.
///
/// # Errors
/// Returns an error string if Argon2 fails (malformed params — not possible at
/// compile-time-validated constants, but surfaced for API completeness).
pub fn derive_key(passphrase: &str, salt: &[u8]) -> Result<MasterKey, String> {
    let params = Params::new(
        ARGON2_MEMORY_KIB,
        ARGON2_ITERATIONS,
        ARGON2_PARALLELISM,
        Some(KEY_LEN),
    )
    .map_err(|e| format!("Argon2 param error: {e}"))?;

    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut key_bytes = [0u8; KEY_LEN];
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, &mut key_bytes)
        .map_err(|e| format!("Argon2 KDF error: {e}"))?;

    Ok(MasterKey { bytes: key_bytes })
}

// ---------------------------------------------------------------------------
// Diceware Passphrase Generator
// ---------------------------------------------------------------------------

pub fn generate_diceware_passphrase(word_count: usize, languages: &[String]) -> String {
    let mut words_list: Vec<&[&str]> = Vec::new();

    let langs_to_check = if languages.is_empty() {
        vec!["english"]
    } else {
        languages.iter().map(|s| s.as_str()).collect()
    };

    for lang in langs_to_check {
        match lang {
            "english" => words_list.push(crate::wordlists::ENGLISH_WORDS),
            "spanish" => words_list.push(crate::wordlists::SPANISH_WORDS),
            "french" => words_list.push(crate::wordlists::FRENCH_WORDS),
            "italian" => words_list.push(crate::wordlists::ITALIAN_WORDS),
            "portuguese" => words_list.push(crate::wordlists::PORTUGUESE_WORDS),
            "czech" => words_list.push(crate::wordlists::CZECH_WORDS),
            _ => {}
        }
    }

    if words_list.is_empty() {
        words_list.push(crate::wordlists::ENGLISH_WORDS);
    }

    let mut rng = OsRng;
    let mut words = Vec::with_capacity(word_count);

    for _ in 0..word_count {
        let list_idx = (rng.next_u32() as usize) % words_list.len();
        let list = words_list[list_idx];
        let count = list.len();

        let index = loop {
            let raw = rng.next_u32() as usize;
            let threshold = (u32::MAX as usize + 1) - (u32::MAX as usize + 1) % count;
            if raw < threshold {
                break raw % count;
            }
        };
        words.push(list[index]);
    }

    words.join("-")
}

/// Normalizes a raw word string through the diacritic-stripping pipeline.
///
/// This is the sanitization function used to clean externally-loaded wordlists.
/// Embedded words in `DICEWARE_WORDS` are pre-sanitized at compile time.
///
/// Pipeline: NFD decompose → strip combining diacritical marks → ASCII only → lowercase.
/// Available for future integration with external wordlist files loaded at runtime.
#[allow(dead_code)]
pub fn sanitize_word(word: &str) -> String {
    word.nfd()
        .filter(|c| c.is_ascii())
        .flat_map(|c| c.to_lowercase())
        .collect::<String>()
        .trim()
        .to_string()
}

// ---------------------------------------------------------------------------
// Vault Encryption / Decryption
// ---------------------------------------------------------------------------

/// Encrypts the vault data and writes it to the given path.
///
/// # Encryption protocol
/// 1. Serialize `VaultData` to JSON plaintext.
/// 2. Generate 12 cryptographically random nonce bytes via OsRng.
/// 3. Encrypt with ChaCha20-Poly1305 (key from `MasterKey`).
///    The library appends a 16-byte Poly1305 authentication tag.
/// 4. Base64-encode salt, nonce, and ciphertext.
/// 5. Write the `VaultFile` JSON envelope to disk.
///
/// # Atomic write safety
/// The JSON is written in a single `fs::write` call. On most file systems this
/// is atomic for small files. For large vaults, a temp-file + rename strategy
/// would be preferred, but is omitted here to keep the implementation minimal.
pub fn encrypt_vault(
    vault_data: &VaultData,
    master_key: &MasterKey,
    vault_path: &PathBuf,
    salt: &[u8; SALT_LEN],
    duress_blob: Option<&DuressBlob>,
) -> Result<(), String> {
    // Serialize plaintext
    let plaintext = serde_json::to_vec(vault_data).map_err(|e| format!("Serialize error: {e}"))?;

    // Generate fresh random nonce — NEVER reuse a nonce with the same key
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    // Construct cipher from derived key
    let cipher = ChaCha20Poly1305::new_from_slice(&master_key.bytes)
        .map_err(|e| format!("Cipher init error: {e}"))?;

    // Encrypt + authenticate. The 16-byte Poly1305 tag is appended to ciphertext.
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| format!("Encryption error: {e}"))?;

    // Build the vault file envelope
    let vault_file = VaultFile {
        magic: VAULT_MAGIC.to_string(),
        version: VAULT_FORMAT_VERSION,
        salt: base64_encode(salt),
        nonce: base64_encode(&nonce_bytes),
        ciphertext: base64_encode(&ciphertext),
        duress_salt: duress_blob.map(|b| base64_encode(&b.salt)),
        duress_nonce: duress_blob.map(|b| base64_encode(&b.nonce)),
        duress_ciphertext: duress_blob.map(|b| base64_encode(&b.ciphertext)),
    };

    let json = serde_json::to_string_pretty(&vault_file)
        .map_err(|e| format!("Vault serialize error: {e}"))?;

    let tmp_path = vault_path.with_extension("blacksite.tmp");
    fs::write(&tmp_path, json).map_err(|e| format!("Vault write error: {e}"))?;
    fs::rename(&tmp_path, vault_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Vault atomic rename error: {e}")
    })?;

    Ok(())
}

/// Decrypts the vault file from disk and returns the plaintext `VaultData`.
///
/// # Authentication
/// ChaCha20-Poly1305 verifies the 16-byte Poly1305 MAC before returning any
/// plaintext. If the key is wrong OR the ciphertext has been tampered with,
/// decryption fails with an authentication error. The caller receives ONLY a
/// generic "decryption failed" message — never partial plaintext.
///
/// # Threat: wrong key
/// A wrong master key produces a MAC mismatch. The error message is identical
/// to a tamper detection error, preventing timing attacks that distinguish
/// "wrong key" from "corrupted file."
pub fn decrypt_vault(
    master_key: &MasterKey,
    vault_path: &PathBuf,
) -> Result<VaultData, String> {
    let json = fs::read_to_string(vault_path)
        .map_err(|e| format!("Vault read error: {e}"))?;

    let vault_file: VaultFile = serde_json::from_str(&json)
        .map_err(|_| "Invalid vault format.".to_string())?;

    if vault_file.magic != VAULT_MAGIC {
        return Err("Invalid vault file — magic mismatch.".to_string());
    }

    let nonce_bytes = base64_decode(&vault_file.nonce)
        .map_err(|_| "Vault nonce decode error.".to_string())?;
    let ciphertext = base64_decode(&vault_file.ciphertext)
        .map_err(|_| "Vault ciphertext decode error.".to_string())?;

    let nonce = Nonce::from_slice(&nonce_bytes);

    let cipher = ChaCha20Poly1305::new_from_slice(&master_key.bytes)
        .map_err(|e| format!("Cipher init error: {e}"))?;

    // Decrypt + verify MAC. Failure here means wrong key OR tampered ciphertext.
    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| "Decryption failed. Wrong passphrase or corrupted vault.".to_string())?;

    let vault_data: VaultData = serde_json::from_slice(&plaintext)
        .map_err(|e| format!("Vault parse error: {e}"))?;

    Ok(vault_data)
}

/// Checks whether a vault file exists at the given path without reading its contents.
pub fn vault_exists(vault_path: &PathBuf) -> bool {
    vault_path.exists()
}

/// Reads and parses just the salt from the vault file without decrypting it.
/// Used during `unlock_vault` to derive the key before attempting decryption.
pub fn read_vault_salt(vault_path: &PathBuf) -> Result<Vec<u8>, String> {
    let json = fs::read_to_string(vault_path)
        .map_err(|e| format!("Vault read error: {e}"))?;

    let vault_file: VaultFile = serde_json::from_str(&json)
        .map_err(|_| "Invalid vault format.".to_string())?;

    base64_decode(&vault_file.salt)
        .map_err(|_| "Salt decode error.".to_string())
}

/// Generates a high-entropy password for individual account entries.
///
/// # Entropy
/// For a length-20 password drawn from an 88-character alphabet
/// (26 lower + 26 upper + 10 digits + 26 symbols), entropy is:
///   log₂(88^20) ≈ 128.6 bits — sufficient to be practically unbreakable
///   against any brute-force attack for the foreseeable future.
///
/// # Implementation
/// Uses rejection sampling to avoid modulo bias (identical to `generate_diceware_passphrase`).
pub fn generate_secure_password(length: usize) -> String {
    const CHARSET: &[u8] = b"abcdefghijklmnopqrstuvwxyz\
                              ABCDEFGHIJKLMNOPQRSTUVWXYZ\
                              0123456789\
                              !@#$%^&*()-_=+[]{}|;:,.<>?";
    let charset_len = CHARSET.len();
    let mut rng = OsRng;
    let mut password = Vec::with_capacity(length);
    let threshold = (u32::MAX as usize + 1) - (u32::MAX as usize + 1) % charset_len;

    for _ in 0..length {
        let idx = loop {
            let raw = rng.next_u32() as usize;
            if raw < threshold {
                break raw % charset_len;
            }
        };
        password.push(CHARSET[idx] as char);
    }

    password.iter().collect()
}

/// Generates a fresh 16-byte random salt for a new vault.
pub fn generate_salt() -> [u8; SALT_LEN] {
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    salt
}

// ---------------------------------------------------------------------------
// Duress Protocol helpers
// ---------------------------------------------------------------------------

/// Builds a DuressBlob by deriving a key from the canary passphrase and
/// encrypting an empty VaultData. This blob is stored in the VaultFile alongside
/// the master ciphertext. On unlock, if the entered passphrase decrypts THIS blob
/// (not the master), the backend triggers the wipe protocol.
pub fn create_duress_blob(canary_passphrase: &str, salt: &[u8; SALT_LEN]) -> Result<DuressBlob, String> {
    let key = derive_key(canary_passphrase, salt)?;

    let empty_vault = VaultData { version: 1, entries: Vec::new() };
    let plaintext = serde_json::to_vec(&empty_vault)
        .map_err(|e| format!("Serialize error: {e}"))?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let cipher = ChaCha20Poly1305::new_from_slice(&key.bytes)
        .map_err(|e| format!("Cipher init error: {e}"))?;

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| format!("Encryption error: {e}"))?;

    Ok(DuressBlob {
        salt: *salt,
        nonce: nonce_bytes,
        ciphertext,
    })
}

/// Reads the duress blob from an existing vault file.
/// Returns None if the vault has no duress fields or if parsing fails.
pub fn read_duress_blob(vault_path: &PathBuf) -> Option<DuressBlob> {
    let json = fs::read_to_string(vault_path).ok()?;
    let vault_file: VaultFile = serde_json::from_str(&json).ok()?;

    let salt_b64 = vault_file.duress_salt?;
    let nonce_b64 = vault_file.duress_nonce?;
    let ct_b64 = vault_file.duress_ciphertext?;

    let salt_bytes = base64_decode(&salt_b64).ok()?;
    let nonce_bytes = base64_decode(&nonce_b64).ok()?;
    let ciphertext = base64_decode(&ct_b64).ok()?;

    if salt_bytes.len() != SALT_LEN || nonce_bytes.len() != NONCE_LEN {
        return None;
    }

    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&salt_bytes);
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&nonce_bytes);

    Some(DuressBlob { salt, nonce, ciphertext })
}

/// Checks whether the given passphrase is the duress/canary key for this vault.
/// Derives the key using the duress salt stored in the vault file and attempts
/// to authenticate the duress ciphertext. Returns Ok(true) on match,
/// Ok(false) on mismatch or missing duress fields.
pub fn try_decrypt_duress(passphrase: &str, vault_path: &PathBuf) -> Result<bool, String> {
    let json = fs::read_to_string(vault_path)
        .map_err(|e| format!("Vault read error: {e}"))?;
    let vault_file: VaultFile = serde_json::from_str(&json)
        .map_err(|_| "Invalid vault format.".to_string())?;

    let (ds, dn, dc) = match (vault_file.duress_salt, vault_file.duress_nonce, vault_file.duress_ciphertext) {
        (Some(s), Some(n), Some(c)) => (s, n, c),
        _ => return Ok(false),
    };

    let salt_bytes = base64_decode(&ds).map_err(|_| "Duress salt decode error.".to_string())?;
    let nonce_bytes = base64_decode(&dn).map_err(|_| "Duress nonce decode error.".to_string())?;
    let ciphertext = base64_decode(&dc).map_err(|_| "Duress ciphertext decode error.".to_string())?;

    let key = derive_key(passphrase, &salt_bytes)?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let cipher = ChaCha20Poly1305::new_from_slice(&key.bytes)
        .map_err(|e| format!("Cipher init error: {e}"))?;

    match cipher.decrypt(nonce, ciphertext.as_ref()) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

/// Overwrites the vault file with zeros and deletes it.
/// Called when the duress key is presented — irreversibly destroys the vault.
pub fn wipe_vault(vault_path: &PathBuf) -> Result<(), String> {
    if vault_path.exists() {
        let len = fs::metadata(vault_path)
            .map(|m| m.len() as usize)
            .unwrap_or(0)
            .max(4096);
        let zeros = vec![0u8; len];
        let _ = fs::write(vault_path, &zeros);
        let _ = fs::remove_file(vault_path);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Internal helpers — minimal base64 without pulling in an external crate
// ---------------------------------------------------------------------------

fn base64_encode(input: &[u8]) -> String {
    BASE64_STANDARD.encode(input)
}

fn base64_decode(input: &str) -> Result<Vec<u8>, &'static str> {
    BASE64_STANDARD.decode(input).map_err(|_| "Invalid base64 string")
}

"""
================================================================================
BLACKSITE NODE – ML Password Strength Engine
Section 1: Data Preparation
================================================================================

PURPOSE
-------
Converts a raw plain-text password list (e.g., rockyou.txt) into ready-to-train
NumPy arrays using a character-level sliding window.  The result is persisted to
disk so the training script can load it without re-processing.

DESIGN DECISIONS
----------------
• Air-gapped / fully offline – zero network calls.
• Fixed vocabulary (printable ASCII) so the tokeniser is deterministic and can be
  shipped alongside the model.
• Sliding-window size (SEQ_LEN) is a hyper-parameter; 10 chars gives the model
  enough context to capture common substitution patterns (p@ssw0rd, etc.).
• Only passwords between MIN_LEN and MAX_LEN chars are kept to avoid training on
  trivially short or pathologically long outliers.
• Labels are one-hot encoded at generation time to avoid re-encoding during
  training, at the cost of slightly more disk I/O – acceptable for a <5 MB model.

USAGE
-----
    python 01_data_preparation.py \
        --passwords rockyou.txt \
        --out_dir   data/ \
        --seq_len   10 \
        --max_rows  500000
"""

import argparse
import json
import os
import string
import sys
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np

# ---------------------------------------------------------------------------
# Vocabulary definition
# ---------------------------------------------------------------------------

# We use the full printable ASCII set minus whitespace, then prepend three
# special tokens so index 0 is always the padding token.
#
#   0  → <PAD>   padding / unknown character
#   1  → <BOS>   beginning-of-sequence sentinel
#   2  → <EOS>   end-of-sequence sentinel (prediction target at string end)
#   3+ → printable characters in deterministic order

_PRINTABLE: str = (
    string.ascii_lowercase   # a-z
    + string.ascii_uppercase # A-Z
    + string.digits          # 0-9
    + string.punctuation     # !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
)

# Build the forward (char → index) and reverse (index → char) mappings once.
# These are exported to JSON alongside the arrays so the inference script can
# reconstruct the exact same vocabulary without this module.
SPECIAL_TOKENS: Dict[str, int] = {"<PAD>": 0, "<BOS>": 1, "<EOS>": 2}

def build_vocabulary() -> Tuple[Dict[str, int], Dict[int, str]]:
    """
    Construct char→index and index→char dictionaries.

    Returns
    -------
    char_to_idx : dict[str, int]
        Maps every supported character (and special tokens) to a unique integer.
    idx_to_char : dict[int, str]
        Inverse mapping used during inference to decode model output.
    """
    char_to_idx: Dict[str, int] = dict(SPECIAL_TOKENS)  # copy specials first

    # Start regular character indices after the three special tokens.
    for idx, ch in enumerate(_PRINTABLE, start=len(SPECIAL_TOKENS)):
        char_to_idx[ch] = idx

    idx_to_char: Dict[int, str] = {v: k for k, v in char_to_idx.items()}
    return char_to_idx, idx_to_char


# ---------------------------------------------------------------------------
# Tokenisation
# ---------------------------------------------------------------------------

def tokenise(password: str, char_to_idx: Dict[str, int]) -> List[int]:
    """
    Convert a raw password string into a list of integer indices.

    Characters not in the vocabulary are silently mapped to <PAD> (0) so
    the model degrades gracefully on unusual Unicode rather than crashing.

    Parameters
    ----------
    password    : Raw password string.
    char_to_idx : Vocabulary mapping produced by build_vocabulary().

    Returns
    -------
    List of integer token indices, including the leading <BOS> and trailing
    <EOS> sentinels.

        e.g. "ab" → [<BOS>, idx('a'), idx('b'), <EOS>]
    """
    pad_idx = char_to_idx["<PAD>"]
    tokens = [char_to_idx["<BOS>"]]
    for ch in password:
        tokens.append(char_to_idx.get(ch, pad_idx))
    tokens.append(char_to_idx["<EOS>"])
    return tokens


# ---------------------------------------------------------------------------
# Sliding-window sequence builder
# ---------------------------------------------------------------------------

def build_sequences(
    token_list: List[int],
    seq_len: int,
    vocab_size: int,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Generate overlapping (input, target) pairs from a single tokenised password.

    For a token list [t0, t1, t2, t3] with seq_len=2 the windows are:
        input=[t0, t1]  →  target=t2
        input=[t1, t2]  →  target=t3

    Parameters
    ----------
    token_list : List of integer token indices for one password (including BOS/EOS).
    seq_len    : Number of preceding characters the model sees as context.
    vocab_size : Total vocabulary size (used for one-hot encoding the label).

    Returns
    -------
    X : np.ndarray of shape (n_windows, seq_len) – integer input sequences.
    y : np.ndarray of shape (n_windows, vocab_size) – one-hot target vectors.
        Returns (None, None) if the token list is shorter than seq_len + 1.
    """
    n = len(token_list)
    if n < seq_len + 1:
        return None, None  # password too short to form even one window

    x_samples: List[List[int]] = []
    y_samples: List[int] = []

    for start in range(n - seq_len):
        window = token_list[start : start + seq_len]   # context window
        target = token_list[start + seq_len]            # next character to predict

        x_samples.append(window)
        y_samples.append(target)

    X = np.array(x_samples, dtype=np.int32)            # (n, seq_len)

    # One-hot encode labels – sparse integers waste memory with large batches.
    y_int = np.array(y_samples, dtype=np.int32)
    Y = np.zeros((len(y_int), vocab_size), dtype=np.float32)
    Y[np.arange(len(y_int)), y_int] = 1.0              # (n, vocab_size)

    return X, Y


# ---------------------------------------------------------------------------
# Dataset builder
# ---------------------------------------------------------------------------

def build_dataset(
    password_file: str,
    char_to_idx: Dict[str, int],
    seq_len: int = 10,
    min_len: int = 4,
    max_len: int = 64,
    max_rows: int = 500_000,
    encoding: str = "latin-1",
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Stream-parse a password file and build the complete (X, y) dataset.

    Parameters
    ----------
    password_file : Path to a plain-text file, one password per line.
    char_to_idx   : Vocabulary mapping.
    seq_len       : Sliding window length (context length).
    min_len       : Discard passwords shorter than this (avoids trivial patterns).
    max_len       : Discard passwords longer than this (avoids outliers).
    max_rows      : Maximum number of password lines to read (memory guard).
    encoding      : File encoding; rockyou.txt uses latin-1.

    Returns
    -------
    X_all : np.ndarray of shape (total_windows, seq_len) – integer inputs.
    y_all : np.ndarray of shape (total_windows, vocab_size) – one-hot targets.
    """
    vocab_size = len(char_to_idx)
    all_X: List[np.ndarray] = []
    all_Y: List[np.ndarray] = []

    rows_read = 0
    skipped   = 0

    print(f"[DataPrep] Reading passwords from: {password_file}")
    print(f"[DataPrep] Vocab size: {vocab_size} | Seq len: {seq_len}")
    print(f"[DataPrep] Password length filter: [{min_len}, {max_len}]")
    print(f"[DataPrep] Max rows: {max_rows:,}")
    print("-" * 60)

    with open(password_file, "r", encoding=encoding, errors="replace") as fh:
        for line in fh:
            if rows_read >= max_rows:
                break

            password = line.rstrip("\n\r")

            # Length guard
            if not (min_len <= len(password) <= max_len):
                skipped += 1
                continue

            tokens = tokenise(password, char_to_idx)
            X, Y   = build_sequences(tokens, seq_len, vocab_size)

            if X is None:
                skipped += 1
                continue

            all_X.append(X)
            all_Y.append(Y)
            rows_read += 1

            if rows_read % 50_000 == 0:
                print(f"  … processed {rows_read:,} passwords …")

    print(f"\n[DataPrep] Done.  Accepted: {rows_read:,} | Skipped: {skipped:,}")

    if not all_X:
        raise RuntimeError(
            "No valid sequences were generated.  "
            "Check --passwords path and length filters."
        )

    X_all = np.concatenate(all_X, axis=0)
    y_all = np.concatenate(all_Y, axis=0)

    print(f"[DataPrep] Dataset shape → X: {X_all.shape}, y: {y_all.shape}")
    return X_all, y_all


# ---------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------

def save_dataset(
    X: np.ndarray,
    y: np.ndarray,
    char_to_idx: Dict[str, int],
    idx_to_char: Dict[int, str],
    out_dir: str,
    seq_len: int,
) -> None:
    """
    Persist the dataset arrays and vocabulary to disk.

    Outputs
    -------
    <out_dir>/X_train.npy        – input sequences
    <out_dir>/y_train.npy        – one-hot labels
    <out_dir>/vocab.json         – char_to_idx mapping
    <out_dir>/dataset_meta.json  – seq_len, vocab_size, etc.
    """
    os.makedirs(out_dir, exist_ok=True)

    np.save(os.path.join(out_dir, "X_train.npy"), X)
    np.save(os.path.join(out_dir, "y_train.npy"), y)

    # json.dumps requires string keys; idx_to_char has int keys so we serialise
    # it with str() conversion.
    vocab_path = os.path.join(out_dir, "vocab.json")
    with open(vocab_path, "w", encoding="utf-8") as fh:
        json.dump(
            {
                "char_to_idx": char_to_idx,
                "idx_to_char": {str(k): v for k, v in idx_to_char.items()},
            },
            fh,
            ensure_ascii=False,
            indent=2,
        )

    meta = {
        "seq_len":    seq_len,
        "vocab_size": len(char_to_idx),
        "n_samples":  int(X.shape[0]),
    }
    meta_path = os.path.join(out_dir, "dataset_meta.json")
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)

    print(f"\n[DataPrep] Saved dataset  → {out_dir}/X_train.npy  ({X.nbytes / 1e6:.1f} MB)")
    print(f"[DataPrep] Saved labels   → {out_dir}/y_train.npy  ({y.nbytes / 1e6:.1f} MB)")
    print(f"[DataPrep] Saved vocab    → {vocab_path}")
    print(f"[DataPrep] Saved metadata → {meta_path}")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Prepare character-level password dataset for LSTM training."
    )
    p.add_argument(
        "--passwords",
        required=True,
        help="Path to the raw password list (one password per line, e.g. rockyou.txt).",
    )
    p.add_argument(
        "--out_dir",
        default="data",
        help="Directory where the dataset arrays and vocabulary will be saved.",
    )
    p.add_argument(
        "--seq_len",
        type=int,
        default=10,
        help="Sliding-window context length (default: 10).",
    )
    p.add_argument(
        "--min_len",
        type=int,
        default=4,
        help="Minimum password length to include (default: 4).",
    )
    p.add_argument(
        "--max_len",
        type=int,
        default=64,
        help="Maximum password length to include (default: 64).",
    )
    p.add_argument(
        "--max_rows",
        type=int,
        default=500_000,
        help="Maximum passwords to read (memory guard, default: 500 000).",
    )
    p.add_argument(
        "--encoding",
        default="latin-1",
        help="File encoding (default: latin-1, which covers rockyou.txt).",
    )
    return p.parse_args()


def main() -> None:
    args = parse_args()

    # --- Validate input ---
    if not Path(args.passwords).is_file():
        sys.exit(f"[ERROR] Password file not found: {args.passwords}")

    # --- Build vocabulary ---
    char_to_idx, idx_to_char = build_vocabulary()
    print(f"[DataPrep] Vocabulary built: {len(char_to_idx)} tokens")

    # --- Process passwords ---
    X, y = build_dataset(
        password_file=args.passwords,
        char_to_idx=char_to_idx,
        seq_len=args.seq_len,
        min_len=args.min_len,
        max_len=args.max_len,
        max_rows=args.max_rows,
        encoding=args.encoding,
    )

    # --- Save everything ---
    save_dataset(X, y, char_to_idx, idx_to_char, args.out_dir, args.seq_len)
    print("\n[DataPrep] ✓ Complete.  Run 02_train.py next.")


if __name__ == "__main__":
    main()

"""
================================================================================
BLACKSITE NODE – ML Password Strength Engine
Section 2: Model Architecture and Training
================================================================================

PURPOSE
-------
Defines and trains a lightweight character-level LSTM that learns the conditional
probability distribution  P(c_t | c_{t-1}, …, c_{t-k})  over the password
character vocabulary.  A well-trained model assigns high probability to common,
predictable passwords and low probability to high-entropy ones — exactly the
signal we need for strength scoring.

MODEL CHOICE – Why LSTM over 1D-CNN here?
------------------------------------------
• LSTM naturally models *sequential* dependencies between characters, which is
  critical for detecting patterns like "l33t" substitutions (p→p, a→@, s→$, …)
  that span non-adjacent positions.
• 1D-CNN excels at parallel feature detection but requires larger kernels to
  capture the same sequential span; for a vocabulary < 100 tokens and sequences
  of 10 chars, an LSTM with 64–128 units is faster to train and more expressive.
• The model is tiny by design (<1 M parameters before quantisation) so it meets
  the <5 MB target even before INT8 compression.

ARCHITECTURE OVERVIEW
---------------------
  Input     : (batch, SEQ_LEN)         integer token indices
  Embedding : (batch, SEQ_LEN, EMBED)  dense float representation per char
  LSTM      : (batch, LSTM_UNITS)      sequence → single hidden state
  Dropout   : regularisation (0.2)
  Dense     : (batch, VOCAB_SIZE)      logits over next-char distribution
  Softmax   : (batch, VOCAB_SIZE)      probability distribution

USAGE
-----
    python 02_train.py \
        --data_dir  data/ \
        --model_dir models/ \
        --epochs    20 \
        --batch     512 \
        --embed_dim 32 \
        --lstm_units 128
"""

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np

# ---------------------------------------------------------------------------
# TensorFlow import – loud error if missing so the user knows what to install.
# ---------------------------------------------------------------------------
try:
    import tensorflow as tf
    from tensorflow import keras
    from tensorflow.keras import layers, callbacks, regularizers
except ImportError:
    sys.exit(
        "[ERROR] TensorFlow is not installed.\n"
        "        Run: pip install tensorflow>=2.13.0\n"
        "        (CPU-only wheels are fine for this workload.)"
    )

print(f"[Train] TensorFlow version: {tf.__version__}")
print(f"[Train] Num GPUs available: {len(tf.config.list_physical_devices('GPU'))}")


# ---------------------------------------------------------------------------
# Model definition
# ---------------------------------------------------------------------------

def build_model(
    vocab_size:  int,
    seq_len:     int,
    embed_dim:   int = 32,
    lstm_units:  int = 128,
    dropout_rate: float = 0.20,
) -> keras.Model:
    """
    Build and return the character-level LSTM language model.

    Parameters
    ----------
    vocab_size   : Total number of unique tokens (including special tokens).
    seq_len      : Fixed input context length (must match data preparation).
    embed_dim    : Dimension of the character embedding space.
                   32 is sufficient; larger values don't help much at char level.
    lstm_units   : Number of LSTM memory cells.
                   128 gives a good accuracy/size trade-off for password data.
    dropout_rate : Fraction of LSTM output units to zero during training.
                   Prevents over-fitting on highly repeated rockyou patterns.

    Returns
    -------
    keras.Model (uncompiled)

    Parameter count breakdown (approximate, vocab_size=100):
        Embedding → 32 * 100            =  3 200
        LSTM      → 4*(128*(32+128)+128)= 132 096
        Dense     → 128 * 100 + 100    =  12 900
        ──────────────────────────────────────────
        Total                          ≈ 148 196  (~0.15 M params)
    """
    # Use the Functional API for clarity and easier future modification.
    inputs = keras.Input(shape=(seq_len,), dtype="int32", name="char_input")

    # ── Embedding ────────────────────────────────────────────────────────────
    # Maps each integer token to a dense vector of size embed_dim.
    # mask_zero=True propagates padding masks through the LSTM so that <PAD>
    # tokens at the beginning of short sequences don't pollute the hidden state.
    x = layers.Embedding(
        input_dim=vocab_size,
        output_dim=embed_dim,
        mask_zero=True,              # ignore <PAD>=0 tokens in LSTM
        name="char_embedding",
    )(inputs)

    # ── LSTM ─────────────────────────────────────────────────────────────────
    # return_sequences=False → we only need the final hidden state to predict
    # the single next character.
    # kernel_regularizer adds small L2 penalty to reduce over-fitting.
    x = layers.LSTM(
        units=lstm_units,
        return_sequences=False,
        kernel_regularizer=regularizers.L2(1e-4),
        recurrent_regularizer=regularizers.L2(1e-4),
        name="lstm_encoder",
    )(x)

    # ── Regularisation ───────────────────────────────────────────────────────
    x = layers.Dropout(rate=dropout_rate, name="dropout")(x)

    # ── Output projection ────────────────────────────────────────────────────
    # Linear (no activation) so we can apply sparse_categorical_crossentropy
    # efficiently.  Softmax is applied externally during inference for numerical
    # stability.
    outputs = layers.Dense(
        units=vocab_size,
        activation="softmax",        # probabilities required by CCE loss
        name="next_char_logits",
    )(x)

    model = keras.Model(inputs=inputs, outputs=outputs, name="PasswordLSTM")
    return model


# ---------------------------------------------------------------------------
# Training helpers
# ---------------------------------------------------------------------------

def load_dataset(data_dir: str):
    """
    Load the NumPy arrays and metadata produced by 01_data_preparation.py.

    Returns
    -------
    X          : np.ndarray  (n, seq_len) integer input sequences
    y          : np.ndarray  (n, vocab_size) one-hot target vectors
    meta       : dict        dataset_meta.json contents
    char_to_idx: dict        vocabulary forward mapping
    """
    data_dir = Path(data_dir)

    required = ["X_train.npy", "y_train.npy", "vocab.json", "dataset_meta.json"]
    for fname in required:
        if not (data_dir / fname).exists():
            sys.exit(
                f"[ERROR] Missing dataset file: {data_dir / fname}\n"
                f"        Run 01_data_preparation.py first."
            )

    X    = np.load(data_dir / "X_train.npy")
    y    = np.load(data_dir / "y_train.npy")

    with open(data_dir / "vocab.json",        encoding="utf-8") as fh:
        vocab = json.load(fh)
    with open(data_dir / "dataset_meta.json", encoding="utf-8") as fh:
        meta  = json.load(fh)

    print(f"[Train] Loaded X: {X.shape}, y: {y.shape}")
    print(f"[Train] Vocab size: {meta['vocab_size']} | Seq len: {meta['seq_len']}")
    return X, y, meta, vocab["char_to_idx"]


def make_callbacks(model_dir: str) -> list:
    """
    Return a curated list of Keras callbacks for robust training.

    Callbacks
    ---------
    ModelCheckpoint : Saves only the best weights (lowest val_loss).
    EarlyStopping   : Halts training if val_loss hasn't improved for N epochs.
    ReduceLROnPlateau: Halves the learning rate when training plateaus.
    TensorBoard     : Optional local TensorBoard logs (ignored if log dir unwritable).
    """
    os.makedirs(model_dir, exist_ok=True)

    ckpt_path = os.path.join(model_dir, "best_model.keras")

    cb_list = [
        # ── Checkpoint: save best weights ────────────────────────────────────
        callbacks.ModelCheckpoint(
            filepath=ckpt_path,
            monitor="val_loss",
            save_best_only=True,
            save_weights_only=False,   # save full model for easy reload
            verbose=1,
        ),
        # ── Early stopping: prevents over-fitting ────────────────────────────
        callbacks.EarlyStopping(
            monitor="val_loss",
            patience=4,               # stop after 4 epochs of no improvement
            restore_best_weights=True,
            verbose=1,
        ),
        # ── Learning-rate reduction on plateau ───────────────────────────────
        callbacks.ReduceLROnPlateau(
            monitor="val_loss",
            factor=0.5,               # halve the LR
            patience=2,
            min_lr=1e-6,
            verbose=1,
        ),
    ]

    # Attempt to add TensorBoard; log dir inside model_dir keeps everything local.
    log_dir = os.path.join(model_dir, "logs")
    try:
        os.makedirs(log_dir, exist_ok=True)
        cb_list.append(callbacks.TensorBoard(log_dir=log_dir, histogram_freq=0))
        print(f"[Train] TensorBoard logs → {log_dir}")
    except OSError:
        print("[Train] TensorBoard log dir unavailable; skipping.")

    return cb_list


# ---------------------------------------------------------------------------
# Main training routine
# ---------------------------------------------------------------------------

def train(args: argparse.Namespace) -> None:
    """End-to-end training pipeline."""

    # ── Load data ────────────────────────────────────────────────────────────
    X, y, meta, char_to_idx = load_dataset(args.data_dir)

    vocab_size = meta["vocab_size"]
    seq_len    = meta["seq_len"]

    # ── Build model ──────────────────────────────────────────────────────────
    model = build_model(
        vocab_size=vocab_size,
        seq_len=seq_len,
        embed_dim=args.embed_dim,
        lstm_units=args.lstm_units,
        dropout_rate=0.20,
    )
    model.summary()

    # ── Compile ──────────────────────────────────────────────────────────────
    # categorical_crossentropy is correct here because y is already one-hot.
    # Adam with a modest LR works reliably for character LMs; we reduce it
    # further via the ReduceLROnPlateau callback.
    model.compile(
        optimizer=keras.optimizers.Adam(learning_rate=1e-3),
        loss="categorical_crossentropy",
        metrics=["accuracy"],
    )

    print(f"\n[Train] Starting training: {args.epochs} epochs, batch {args.batch}")

    # ── Fit ──────────────────────────────────────────────────────────────────
    history = model.fit(
        X, y,
        epochs=args.epochs,
        batch_size=args.batch,
        validation_split=0.10,       # 10 % held out for val_loss tracking
        shuffle=True,
        callbacks=make_callbacks(args.model_dir),
        verbose=1,
    )

    # ── Final save ───────────────────────────────────────────────────────────
    final_path = os.path.join(args.model_dir, "final_model.keras")
    model.save(final_path)
    print(f"\n[Train] ✓ Final model saved → {final_path}")

    # Also save the vocab alongside the model so everything needed for export
    # and inference lives in model_dir.
    import shutil
    shutil.copy(
        os.path.join(args.data_dir, "vocab.json"),
        os.path.join(args.model_dir, "vocab.json"),
    )
    shutil.copy(
        os.path.join(args.data_dir, "dataset_meta.json"),
        os.path.join(args.model_dir, "dataset_meta.json"),
    )
    print(f"[Train] ✓ Vocab + meta mirrored → {args.model_dir}")

    # Print final loss/accuracy
    val_loss  = min(history.history["val_loss"])
    val_acc   = max(history.history["val_accuracy"])
    print(f"[Train] Best val_loss: {val_loss:.4f} | Best val_accuracy: {val_acc:.4f}")
    print("\n[Train] ✓ Complete.  Run 03_export.py next.")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Train the character-level LSTM password language model."
    )
    p.add_argument("--data_dir",   default="data",   help="Directory with dataset .npy files.")
    p.add_argument("--model_dir",  default="models", help="Directory where model will be saved.")
    p.add_argument("--epochs",     type=int, default=20,  help="Max training epochs (default: 20).")
    p.add_argument("--batch",      type=int, default=512, help="Mini-batch size (default: 512).")
    p.add_argument("--embed_dim",  type=int, default=32,  help="Character embedding dimension.")
    p.add_argument("--lstm_units", type=int, default=128, help="LSTM hidden state size.")
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()
    train(args)

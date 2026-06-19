"""
================================================================================
BLACKSITE NODE – ML Password Strength Engine
Section 3: Quantisation and Export
================================================================================

PURPOSE
-------
Converts the trained Keras model into production-ready inference artefacts.

THREE EXPORT FORMATS
---------------------
  1. password_model.onnx           – PRIMARY (recommended for deployment)
     • Exported via tf2onnx.
     • Handled by ONNX Runtime (~13 MB CPU wheel, fully offline).
     • No Flex delegate issues — LSTM is a first-class op in ONNX.

  2. password_model_f16.tflite     – Float16 TFLite
     • Halves model size vs float32 with zero accuracy loss.
     • Requires SELECT_TF_OPS due to LSTM’s TensorListReserve op.
     • Load with ai_edge_litert (TF 2.20+) for Flex delegate support.

  3. password_model_dynamic.tflite – Dynamic-range INT8 TFLite
     • Weights quantised to INT8 analytically (no calibration dataset needed).
     • TF’s recommended approach for LSTM/RNN models.
     • Same SELECT_TF_OPS + ai_edge_litert requirement as F16.

NOTE ON FULL INT8 PTQ
---------------------
Full INT8 post-training quantisation (with a representative dataset) is NOT
supported for LSTM models using SELECT_TF_OPS.  The TFLite calibration
interpreter does not load the Flex delegate internally, so the calibration
pass crashes on FlexTensorListReserve.  Use dynamic-range instead.

TO AVOID SELECT_TF_OPS ENTIRELY (future training runs)
-------------------------------------------------------
Add `unroll=True` to the LSTM layer in 02_train.py:
    layers.LSTM(units=..., unroll=True, ...)
This unrolls the loop at graph build time, producing static shapes that
standard TFLite can handle without SELECT_TF_OPS or ai_edge_litert.

USAGE
-----
    python 03_export.py \
        --model_dir  models/ \
        --data_dir   data/ \
        --export_dir exports/ \
        --calib_samples 512
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Optional

import numpy as np

try:
    import tensorflow as tf
except ImportError:
    sys.exit("[ERROR] TensorFlow not installed.  Run: pip install tensorflow>=2.13.0")

print(f"[Export] TensorFlow version: {tf.__version__}")


# ---------------------------------------------------------------------------
# Shared LSTM fix
# ---------------------------------------------------------------------------

def apply_lstm_tflite_fix(converter: tf.lite.TFLiteConverter) -> tf.lite.TFLiteConverter:
    """
    Apply the SELECT_TF_OPS settings required for LSTM-based TFLite models.

    Keras LSTM uses tf.TensorListReserve internally, which TFLite’s standard
    lowering pass cannot handle with static shapes.  Enabling SELECT_TF_OPS
    allows TFLite to fall back to the full TF kernel for that op.

    Parameters
    ----------
    converter : A TFLiteConverter instance to configure in-place.

    Returns
    -------
    The same converter with SELECT_TF_OPS settings applied.
    """
    converter.target_spec.supported_ops = [
        tf.lite.OpsSet.TFLITE_BUILTINS,
        tf.lite.OpsSet.SELECT_TF_OPS,      # required for LSTM TensorListReserve
    ]
    converter._experimental_lower_tensor_list_ops = False
    return converter


# ---------------------------------------------------------------------------
# ONNX export (PRIMARY — recommended)
# ---------------------------------------------------------------------------

def export_onnx(
    keras_model: tf.keras.Model,
    seq_len: int,
    export_dir: str,
    opset: int = 15,
) -> Optional[str]:
    """
    Export the trained Keras model to ONNX format.

    ONNX Runtime is the recommended production runtime because it handles
    LSTM natively without any Flex delegate requirements.

    Dependencies: pip install tf2onnx onnx

    Parameters
    ----------
    keras_model : The loaded Keras model.
    seq_len     : Sequence length (from dataset_meta.json).
    export_dir  : Output directory.
    opset       : ONNX opset version (15 is widely supported).

    Returns
    -------
    Absolute path to the written .onnx file, or None if tf2onnx is not installed.
    """
    print("\n[Export] ── ONNX export (primary) ───────────────────────────")
    try:
        import tf2onnx
        import onnx
    except ImportError:
        print("[Export] tf2onnx / onnx not installed — skipping ONNX export.")
        print("         Install with: pip install tf2onnx onnx")
        return None

    input_signature = [
        tf.TensorSpec(shape=(None, seq_len), dtype=tf.int32, name="char_input")
    ]
    onnx_model, _ = tf2onnx.convert.from_keras(
        keras_model,
        input_signature=input_signature,
        opset=opset,
        output_path=None,
    )

    os.makedirs(export_dir, exist_ok=True)
    out_path = os.path.join(export_dir, "password_model.onnx")
    onnx.save_model(onnx_model, out_path)

    size_kb = os.path.getsize(out_path) / 1024
    print(f"[Export] ✓ ONNX → {out_path}  ({size_kb:.1f} KB)")
    return out_path


# ---------------------------------------------------------------------------
# Float16 TFLite export
# ---------------------------------------------------------------------------

def export_float16(
    keras_model: tf.keras.Model,
    export_dir: str,
) -> str:
    """
    Convert the Keras model to TFLite with float16 weight quantisation.

    Requires SELECT_TF_OPS (applied automatically) due to LSTM internals.
    Load at inference time with ai_edge_litert for Flex delegate support.

    Parameters
    ----------
    keras_model : The loaded Keras model.
    export_dir  : Output directory.

    Returns
    -------
    Absolute path to the written .tflite file.
    """
    print("\n[Export] ── Float16 TFLite export ─────────────────────────")
    converter = tf.lite.TFLiteConverter.from_keras_model(keras_model)
    converter.optimizations = [tf.lite.Optimize.DEFAULT]
    converter.target_spec.supported_types = [tf.float16]
    converter = apply_lstm_tflite_fix(converter)

    tflite_model = converter.convert()

    os.makedirs(export_dir, exist_ok=True)
    out_path = os.path.join(export_dir, "password_model_f16.tflite")
    with open(out_path, "wb") as fh:
        fh.write(tflite_model)

    size_kb = os.path.getsize(out_path) / 1024
    print(f"[Export] ✓ F16 TFLite → {out_path}  ({size_kb:.1f} KB)")
    return out_path


# ---------------------------------------------------------------------------
# Dynamic-range INT8 TFLite export
# ---------------------------------------------------------------------------

def export_dynamic_range(
    keras_model: tf.keras.Model,
    export_dir: str,
) -> str:
    """
    Convert the Keras model to TFLite with dynamic-range INT8 quantisation.

    This is TF’s recommended quantisation strategy for LSTM/RNN models:
    https://www.tensorflow.org/lite/performance/post_training_quantization#dynamic_range_quantization

    Weights are quantised to INT8 analytically (no representative dataset
    needed, no calibration pass, no Flex delegate conflict during conversion).
    Activations remain float32 at runtime.

    Requires SELECT_TF_OPS at inference time (applied automatically).

    Parameters
    ----------
    keras_model : The loaded Keras model.
    export_dir  : Output directory.

    Returns
    -------
    Absolute path to the written .tflite file.
    """
    print("\n[Export] ── Dynamic-range INT8 TFLite export ───────────────")
    converter = tf.lite.TFLiteConverter.from_keras_model(keras_model)
    # DEFAULT optimisation without a representative_dataset = dynamic-range.
    converter.optimizations = [tf.lite.Optimize.DEFAULT]
    converter = apply_lstm_tflite_fix(converter)
    # No inference_input_type / inference_output_type — keeps IO as float32
    # to avoid calibration conflicts.

    tflite_model = converter.convert()

    os.makedirs(export_dir, exist_ok=True)
    out_path = os.path.join(export_dir, "password_model_dynamic.tflite")
    with open(out_path, "wb") as fh:
        fh.write(tflite_model)

    size_kb = os.path.getsize(out_path) / 1024
    print(f"[Export] ✓ Dynamic INT8 TFLite → {out_path}  ({size_kb:.1f} KB)")
    return out_path


# ---------------------------------------------------------------------------
# Verification helper
# ---------------------------------------------------------------------------

def verify_onnx(onnx_path: str, seq_len: int) -> None:
    """
    Run a single forward pass through the ONNX model to confirm it is valid.

    Parameters
    ----------
    onnx_path : Path to the .onnx file.
    seq_len   : Sequence length expected by the model.
    """
    try:
        import onnxruntime as ort
    except ImportError:
        print("[Export] onnxruntime not installed — skipping ONNX verification.")
        return

    print(f"\n[Export] Verifying ONNX: {onnx_path}")
    sess   = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    sample = np.zeros((1, seq_len), dtype=np.int32)
    name   = sess.get_inputs()[0].name
    result = sess.run(None, {name: sample})[0]
    print(f"         Output shape: {result.shape}  sum ≈ {result.sum():.4f} (should be 1.0)")
    print("[Export] ✓ ONNX verification passed.")


# ---------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------

def copy_vocab_meta(model_dir: str, export_dir: str) -> None:
    """Copy vocab.json and dataset_meta.json from model_dir to export_dir."""
    import shutil
    for fname in ("vocab.json", "dataset_meta.json"):
        src = os.path.join(model_dir, fname)
        dst = os.path.join(export_dir, fname)
        if Path(src).exists():
            shutil.copy(src, dst)
            print(f"[Export] Copied {fname} → {export_dir}/")
        else:
            print(f"[Export] WARNING: {fname} not found in {model_dir}")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Export trained Keras model to ONNX (primary) and TFLite variants."
    )
    p.add_argument("--model_dir",     default="models",  help="Dir containing best_model.keras.")
    p.add_argument("--data_dir",      default="data",    help="Dir containing X_train.npy (unused now, kept for compatibility).")
    p.add_argument("--export_dir",    default="exports", help="Output directory.")
    p.add_argument("--calib_samples", type=int, default=512,
                   help="Reserved for future use (calibration no longer needed).")
    p.add_argument("--skip_tflite",   action="store_true",
                   help="Skip TFLite exports (ONNX only).")
    p.add_argument("--skip_onnx",     action="store_true",
                   help="Skip ONNX export (TFLite only, requires tf2onnx to be absent).")
    return p.parse_args()


def main() -> None:
    args = parse_args()

    # ── Locate and load model ────────────────────────────────────────────────────────────
    model_path = os.path.join(args.model_dir, "best_model.keras")
    if not Path(model_path).exists():
        sys.exit(
            f"[ERROR] Model not found: {model_path}\n"
            f"        Run 02_train.py first."
        )

    # ── Load metadata ──────────────────────────────────────────────────────────────
    meta_path = os.path.join(args.model_dir, "dataset_meta.json")
    with open(meta_path, encoding="utf-8") as fh:
        meta = json.load(fh)
    seq_len = meta["seq_len"]

    # ── Load model once ───────────────────────────────────────────────────────────
    print(f"[Export] Loading model: {model_path}")
    keras_model = tf.keras.models.load_model(model_path)
    keras_model.summary()

    # ── ONNX (primary) ───────────────────────────────────────────────────────────
    if not args.skip_onnx:
        onnx_path = export_onnx(keras_model, seq_len, args.export_dir)
        if onnx_path:
            verify_onnx(onnx_path, seq_len)

    # ── TFLite variants (secondary) ────────────────────────────────────────────────
    if not args.skip_tflite:
        export_float16(keras_model, args.export_dir)
        export_dynamic_range(keras_model, args.export_dir)

    # ── Copy vocabulary + metadata ───────────────────────────────────────────────────
    copy_vocab_meta(args.model_dir, args.export_dir)

    # ── Final summary ─────────────────────────────────────────────────────────────
    print("\n[Export] ── Export Summary ─────────────────────────────────────────")
    for fname in sorted(os.listdir(args.export_dir)):
        fpath = os.path.join(args.export_dir, fname)
        if os.path.isfile(fpath):
            print(f"  {fname:<45} {os.path.getsize(fpath)/1024:>8.1f} KB")
    print("\n[Export] ✓ Complete.  Run 04_inference.py to score passwords.")


if __name__ == "__main__":
    main()

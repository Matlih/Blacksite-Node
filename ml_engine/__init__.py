"""
BLACKSITE NODE – ML Engine Public API
======================================
Import the PasswordScorer class for use in other modules.

Example
-------
from ml_engine import PasswordScorer

scorer = PasswordScorer(
    model_path="ml_engine/exports/password_model.onnx",
    vocab_path="ml_engine/exports/vocab.json",
    meta_path="ml_engine/exports/dataset_meta.json",
)

result = scorer.score("P@ssw0rd!")
# result = {
#   "label":       "Moderate",
#   "nll":         2.31,
#   "joint_log_p": -46.2,
#   "joint_p":     2.1e-21,
#   "color_hint":  "#fb8c00",
#   "description": "...",
#   "char_count":  9,
# }
"""

import importlib.util
from pathlib import Path

# Python module names cannot start with a digit, so we cannot use
# `from .04_inference import ...` directly.  importlib.util.spec_from_file_location
# bypasses the naming restriction and loads the file by path.
_inference_path = Path(__file__).parent / "04_inference.py"
_spec = importlib.util.spec_from_file_location("ml_engine.inference", _inference_path)
_inference_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_inference_mod)

PasswordScorer = _inference_mod.PasswordScorer
STRENGTH_TIERS = _inference_mod.STRENGTH_TIERS
StrengthLabel  = _inference_mod.StrengthLabel

__all__ = ["PasswordScorer", "STRENGTH_TIERS", "StrengthLabel"]

"""
================================================================================
BLACKSITE NODE – ML Password Strength Engine
Section 4: Inference and Scoring (Local / Offline Deployment)
================================================================================

PURPOSE
-------
This is the ONLY module that needs to ship with the password manager.
It has ZERO training dependencies — it uses only:

    onnxruntime (standalone CPU wheel, ~13 MB) OR ai-edge-litert / tf.lite
    numpy
    json  (stdlib)
    math  (stdlib)

It loads a .tflite model from disk and scores any given password by computing
the character-level joint probability (negative log-perplexity), then maps the
score to a human-readable strength label.

MATHEMATICAL FOUNDATION
-----------------------
Given a password p = c_1 c_2 … c_n, the model estimates:

    P(c_t | c_{t-k}, …, c_{t-1})    for each position t

The JOINT probability of the entire password is:

    P(p) = ∏_{t=k+1}^{n} P(c_t | c_{t-k}, …, c_{t-1})

Taking the log (to avoid numerical underflow with long products):

    log P(p) = ∑_{t=k+1}^{n} log P(c_t | c_{t-k}, …, c_{t-1})

This is the *log-likelihood* of the password under the learned distribution.

We normalise by password length to get the per-character *log-perplexity*:

    NLL_per_char = -log P(p) / (n - k)

    • LOW  NLL  → model predicts the password easily → it IS a common pattern → WEAK
    • HIGH NLL  → model is surprised at every step   → high entropy           → STRONG

This is exactly the inverse of a typical "strength" intuition:
    high predictability = weak, low predictability = strong.

THRESHOLDING
------------
The thresholds below were calibrated empirically on RockYou passwords
(500 k sample, seq_len=10):

    NLL_per_char < 1.5  → "Weak"     (very common patterns, e.g. "password1")
    1.5 ≤ NLL < 3.0     → "Moderate" (some structure, e.g. "P@ssw0rd!")
    NLL ≥ 3.0           → "Strong"   (high entropy, e.g. "xK#9mP2$vQ")

Adjust these constants to match your dataset's perplexity distribution.

USAGE
-----
As a script:
    python 04_inference.py \
        --model  exports/password_model.onnx \
        --vocab  exports/vocab.json \
        --meta   exports/dataset_meta.json

As an imported module (from your Tauri Rust/Python bridge):
    from ml_engine import PasswordScorer
    scorer = PasswordScorer(model_path, vocab_path, meta_path)
    result = scorer.score("MySecretP@ss!")
    print(result)  # {'label': 'Moderate', 'nll': 2.34, 'probability': 9.6e-18}

SUPPORTED MODEL FORMATS
-----------------------
  .onnx   → ONNX Runtime (recommended — handles LSTM natively, ~50 MB install)
  .tflite → TFLite via ai_edge_litert or tf.lite (requires unroll=True LSTM
            to avoid Flex delegate dependency)
"""

import argparse
import json
import math
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np

# ---------------------------------------------------------------------------
# Runtime backend detection
# Priority order:
#   1. ONNX Runtime  – recommended for LSTM models; handles all op types natively.
#                      Install: pip install onnxruntime  (offline, ~50 MB, CPU-only)
#   2. ai_edge_litert – TF 2.20's official TFLite replacement.
#                      Install: pip install ai-edge-litert
#   3. tf.lite        – bundled with full TensorFlow installation.
#
# NOTE: backends 2 and 3 require the model to be built with unroll=True in the
# LSTM layer OR to have been compiled with SELECT_TF_OPS + a Flex delegate.
# If you see "FlexTensorListReserve" errors, use the ONNX model instead.
# ---------------------------------------------------------------------------

_BACKEND: str = "none"

try:
    import onnxruntime as _ort
    _BACKEND = "onnxruntime"
except ImportError:
    pass

if _BACKEND == "none":
    try:
        from ai_edge_litert.interpreter import Interpreter as _TFLiteInterpreter
        _BACKEND = "ai_edge_litert"
    except ImportError:
        pass

if _BACKEND == "none":
    try:
        import tensorflow as _tf
        _TFLiteInterpreter = _tf.lite.Interpreter
        _BACKEND = "tensorflow.lite"
    except ImportError:
        pass

if _BACKEND == "none":
    sys.exit(
        "[ERROR] No inference runtime found.  Install one of:\n"
        "  pip install onnxruntime        (recommended — handles LSTM natively)\n"
        "  pip install ai-edge-litert     (TFLite, needs unroll=True LSTM)\n"
    )

print(f"[Inference] Runtime backend: {_BACKEND}")


# ---------------------------------------------------------------------------
# Strength label configuration
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class StrengthLabel:
    """Immutable descriptor for a strength tier."""
    label:       str   # Human-readable label
    color_hint:  str   # Semantic color hint for UI integration
    description: str   # Short explanation


# Ordered from weakest to strongest; thresholds are upper bounds on NLL.
# The last tier has no upper bound (open-ended).
STRENGTH_TIERS: List[Tuple[float, StrengthLabel]] = [
    (
        1.5,
        StrengthLabel(
            label="Weak",
            color_hint="#e53935",  # red
            description=(
                "Highly predictable.  Found in common password lists. "
                "Susceptible to dictionary and rule-based attacks."
            ),
        ),
    ),
    (
        3.0,
        StrengthLabel(
            label="Moderate",
            color_hint="#fb8c00",  # amber
            description=(
                "Some structural complexity, but exhibits learnable patterns. "
                "Recommend adding random symbols or increasing length."
            ),
        ),
    ),
    (
        math.inf,
        StrengthLabel(
            label="Strong",
            color_hint="#43a047",  # green
            description=(
                "High entropy.  Unlikely to appear in training data. "
                "Resistant to learned substitution-pattern attacks."
            ),
        ),
    ),
]


# ---------------------------------------------------------------------------
# Vocabulary helpers (mirrors 01_data_preparation.py – no import dependency)
# ---------------------------------------------------------------------------

def load_vocab(vocab_path: str) -> Tuple[Dict[str, int], Dict[int, str]]:
    """
    Load the character vocabulary saved by the data preparation step.

    Parameters
    ----------
    vocab_path : Path to vocab.json.

    Returns
    -------
    char_to_idx : str → int mapping
    idx_to_char : int → str mapping (keys are integers, not strings)
    """
    with open(vocab_path, "r", encoding="utf-8") as fh:
        vocab_data = json.load(fh)

    char_to_idx: Dict[str, int] = vocab_data["char_to_idx"]
    # JSON keys are always strings; convert numeric keys back to int.
    idx_to_char: Dict[int, str] = {
        int(k): v for k, v in vocab_data["idx_to_char"].items()
    }
    return char_to_idx, idx_to_char


def tokenise_password(
    password: str,
    char_to_idx: Dict[str, int],
) -> List[int]:
    """
    Convert a password string to a list of integer token indices.

    Unknown characters are silently mapped to <PAD> (0); this degrades
    gracefully on non-ASCII passwords rather than raising an exception.

    Parameters
    ----------
    password    : The plaintext password to score.
    char_to_idx : Forward vocabulary mapping.

    Returns
    -------
    List of integer indices including leading <BOS> and trailing <EOS>.
    """
    pad_idx = char_to_idx.get("<PAD>", 0)
    tokens  = [char_to_idx["<BOS>"]]
    for ch in password:
        tokens.append(char_to_idx.get(ch, pad_idx))
    tokens.append(char_to_idx["<EOS>"])
    return tokens


# ---------------------------------------------------------------------------
# Core scoring engine
# ---------------------------------------------------------------------------

class PasswordScorer:
    """
    Offline, air-gapped password strength scorer.

    Supports two model formats:
      • .onnx   → loaded via ONNX Runtime (recommended)
      • .tflite → loaded via ai_edge_litert or tf.lite

    The backend is selected automatically at module load time based on what
    is installed.  The scorer is stateful (interpreter/session kept alive)
    but NOT thread-safe — create one instance per thread.

    Parameters
    ----------
    model_path  : Path to the .onnx or .tflite model file.
    vocab_path  : Path to vocab.json.
    meta_path   : Path to dataset_meta.json.
    num_threads : CPU threads for inference (default: 2).
    """

    def __init__(
        self,
        model_path: str,
        vocab_path: str,
        meta_path:  str,
        num_threads: int = 2,
    ) -> None:
        # ── Validate paths ────────────────────────────────────────────────────
        for label, path in [("model", model_path), ("vocab", vocab_path), ("meta", meta_path)]:
            if not Path(path).is_file():
                raise FileNotFoundError(f"[PasswordScorer] {label} file not found: {path}")

        # ── Load vocabulary ───────────────────────────────────────────────────
        self.char_to_idx, self.idx_to_char = load_vocab(vocab_path)
        self.vocab_size = len(self.char_to_idx)
        self.pad_idx    = self.char_to_idx.get("<PAD>", 0)

        # ── Load metadata ─────────────────────────────────────────────────────
        with open(meta_path, "r", encoding="utf-8") as fh:
            meta = json.load(fh)
        self.seq_len: int = meta["seq_len"]

        # ── Load inference backend ────────────────────────────────────────────
        ext = Path(model_path).suffix.lower()

        if ext == ".onnx":
            # ── ONNX Runtime path ─────────────────────────────────────────────
            if _BACKEND != "onnxruntime":
                raise RuntimeError(
                    "Model is .onnx but onnxruntime is not installed.\n"
                    "Run: pip install onnxruntime"
                )
            sess_options = _ort.SessionOptions()
            sess_options.intra_op_num_threads = num_threads
            sess_options.inter_op_num_threads = num_threads
            # CPU-only provider keeps inference fully offline.
            self._ort_session = _ort.InferenceSession(
                model_path,
                sess_options=sess_options,
                providers=["CPUExecutionProvider"],
            )
            # Cache the input name for the run() call.
            self._ort_input_name = self._ort_session.get_inputs()[0].name
            self._backend = "onnxruntime"
            print(
                f"[PasswordScorer] ONNX Runtime backend\n"
                f"  Model      : {Path(model_path).name}\n"
                f"  Input name : {self._ort_input_name}\n"
                f"  Seq len    : {self.seq_len}\n"
                f"  Vocab size : {self.vocab_size}"
            )

        elif ext == ".tflite":
            # ── TFLite path ───────────────────────────────────────────────────
            if _BACKEND not in ("ai_edge_litert", "tensorflow.lite"):
                raise RuntimeError(
                    "Model is .tflite but no TFLite runtime is available.\n"
                    "Run: pip install ai-edge-litert"
                )
            self._tflite_interp = _TFLiteInterpreter(
                model_path=model_path,
                num_threads=num_threads,
            )
            self._tflite_interp.allocate_tensors()
            self._input_details  = self._tflite_interp.get_input_details()
            self._output_details = self._tflite_interp.get_output_details()
            self._input_dtype    = self._input_details[0]["dtype"]
            self._backend = _BACKEND
            print(
                f"[PasswordScorer] TFLite backend ({_BACKEND})\n"
                f"  Model       : {Path(model_path).name}\n"
                f"  Input dtype : {self._input_dtype}\n"
                f"  Seq len     : {self.seq_len}\n"
                f"  Vocab size  : {self.vocab_size}"
            )

        else:
            raise ValueError(
                f"Unsupported model format: '{ext}'.  "
                "Use a .onnx or .tflite file."
            )

    # ── Internal: single model inference call ────────────────────────────────

    def _predict_next_char_probs(self, context_window: np.ndarray) -> np.ndarray:
        """
        Run one forward pass for a single context window.

        Dispatches to the correct backend (ONNX Runtime or TFLite) transparently.

        Parameters
        ----------
        context_window : np.ndarray of shape (seq_len,) — integer token indices.

        Returns
        -------
        probs : np.ndarray of shape (vocab_size,) — softmax probability distribution
                over the next character.  Promoted to float64 for log stability.
        """
        if self._backend == "onnxruntime":
            # ONNX Runtime expects int32 input with shape [1, seq_len].
            feed = {self._ort_input_name: context_window.reshape(1, self.seq_len).astype(np.int32)}
            probs = self._ort_session.run(None, feed)[0][0]  # [0]=first output, [0]=unbatch

        else:
            # TFLite path — cast to whatever dtype the model was compiled with.
            input_tensor = context_window.reshape(1, self.seq_len).astype(self._input_dtype)
            self._tflite_interp.set_tensor(self._input_details[0]["index"], input_tensor)
            self._tflite_interp.invoke()
            probs = self._tflite_interp.get_tensor(self._output_details[0]["index"])[0]  # unbatch

        return probs.astype(np.float64)  # promote to float64 for numerical stability in log()

    # ── Public scoring API ───────────────────────────────────────────────────

    def compute_log_likelihood(self, password: str) -> Tuple[float, int]:
        """
        Compute the total log-likelihood of a password under the language model.

        Mathematics
        -----------
        For each position t where we have a full context window of length SEQ_LEN:

            log_likelihood += log( P(c_t | c_{t-SEQ_LEN}, …, c_{t-1}) )

        The sum is accumulated in log-space to avoid floating-point underflow
        that would occur if we multiplied very small probabilities together.

        Parameters
        ----------
        password : Plaintext password string to evaluate.

        Returns
        -------
        log_likelihood : float  (negative, larger magnitude = lower probability)
        n_predictions  : int    number of character predictions made
        """
        tokens = tokenise_password(password, self.char_to_idx)
        n      = len(tokens)

        log_likelihood  = 0.0
        n_predictions   = 0

        # Slide the context window along the token sequence.
        for start in range(n - self.seq_len):
            window      = np.array(tokens[start : start + self.seq_len], dtype=np.int32)
            target_idx  = tokens[start + self.seq_len]  # the character we're predicting

            # Get P( next_char | window ) from the model.
            probs       = self._predict_next_char_probs(window)

            # Probability of the actual next character.
            p_target    = probs[target_idx]

            # Clamp probability to [epsilon, 1] to avoid log(0) = -inf.
            # epsilon = 1e-9 ≈ 9 bits of surprise at minimum, preventing
            # degenerate scores for unseen characters.
            EPSILON     = 1e-9
            p_clamped   = max(float(p_target), EPSILON)

            log_likelihood  += math.log(p_clamped)
            n_predictions   += 1

        return log_likelihood, n_predictions

    def compute_nll_per_char(self, password: str) -> float:
        """
        Compute the Negative Log-Likelihood per character (NLL).

        NLL = -log P(p) / n_chars

        A higher NLL means the model is more "surprised" → the password is
        less predictable → stronger.

        Parameters
        ----------
        password : Plaintext password.

        Returns
        -------
        nll_per_char : float
            0 if the password is too short to form a context window.
        """
        tokens = tokenise_password(password, self.char_to_idx)
        if len(tokens) <= self.seq_len:
            # Password too short to evaluate; return 0 (scores as Weak by default).
            return 0.0

        log_likelihood, n_predictions = self.compute_log_likelihood(password)
        if n_predictions == 0:
            return 0.0

        # Negate because log_likelihood is negative; divide to normalise by length.
        nll_per_char = -log_likelihood / n_predictions
        return nll_per_char

    def get_strength_label(self, nll_per_char: float) -> StrengthLabel:
        """
        Map a NLL-per-char score to a human-readable StrengthLabel.

        Iterates the STRENGTH_TIERS list (ordered weakest→strongest) and
        returns the first tier whose upper-bound threshold the NLL exceeds.

        Parameters
        ----------
        nll_per_char : Normalised NLL from compute_nll_per_char().

        Returns
        -------
        StrengthLabel dataclass instance.
        """
        for threshold, strength in STRENGTH_TIERS:
            if nll_per_char < threshold:
                return strength
        # Should never reach here; return the strongest tier as a safe default.
        return STRENGTH_TIERS[-1][1]

    # ── Hybrid short-password scorer ─────────────────────────────────────────

    def _static_score(self, password: str) -> Optional[float]:
        """
        Rule-based pre-check for passwords too short for the LSTM to evaluate.

        The model requires at least (seq_len + 1) tokens to form one prediction
        window.  Passwords shorter than seq_len characters fall into this path.

        Instead of returning a blanket 0.0 (which is correct but uninformative),
        we use character-set diversity as a proxy for NLL strength, mapped to
        the same NLL scale used by the model:

            Diversity types counted: uppercase, digits, symbols

            0 types → 0.5   (all lowercase, e.g. "dog")     → Weak
            1 type  → 1.0   (lowercase + digits, e.g. "abc9")  → Weak
            2 types → 1.8   (mixed case + digit, e.g. "Abc9")  → Moderate
            3 types → 2.5   (upper + digit + symbol, e.g. "Ab9!") → Moderate

        Note: even 3-type short passwords score Moderate at best — length
        matters and short passwords are inherently guessable.

        Parameters
        ----------
        password : The raw password string.

        Returns
        -------
        float  – NLL-equivalent score if the password is too short to model.
        None   – if the password is long enough for the model to evaluate.
        """
        length = len(password)

        # Anything under 6 characters is trivially brute-forceable regardless
        # of character set — clamp to Weak immediately.
        if length < 6:
            return 0.0

        # Password is within the unmodelable range but ≥ 6 chars.
        if length <= self.seq_len:
            has_upper  = any(c.isupper()   for c in password)
            has_digit  = any(c.isdigit()   for c in password)
            has_symbol = any(not c.isalnum() for c in password)
            diversity  = sum([has_upper, has_digit, has_symbol])
            return [0.5, 1.0, 1.8, 2.5][diversity]

        # Long enough — let the model evaluate normally.
        return None


    def score(self, password: str) -> dict:
        """
        High-level API: score a password and return a structured result dict.

        This is the primary entry point for integration with the password manager.

        Parameters
        ----------
        password : The password string to evaluate.

        Returns
        -------
        result : dict with keys:
            password    – the evaluated password (use carefully; never log this)
            nll         – NLL per character (float, higher = stronger)
            joint_log_p – total log P(password) (float, negative)
            joint_p     – approximate joint probability as a float
            label       – "Weak", "Moderate", or "Strong"
            color_hint  – hex color for UI rendering
            description – human-readable explanation
            char_count  – number of characters in the password
        """
        if not password:
            return {
                "password":    "",
                "nll":         0.0,
                "joint_log_p": -math.inf,
                "joint_p":     0.0,
                "label":       "Weak",
                "color_hint":  STRENGTH_TIERS[0][1].color_hint,
                "description": "Empty password.",
                "char_count":  0,
            }

        tokens = tokenise_password(password, self.char_to_idx)

        # ── Short-password path: hybrid static scorer ─────────────────────────
        static_nll = self._static_score(password)
        if static_nll is not None:
            # The model cannot evaluate this password (too few chars for a
            # context window).  Use the diversity-based proxy NLL instead.
            nll     = static_nll
            log_p   = -9999.0  # Avoid -math.inf to prevent invalid JSON (-Infinity)
            joint_p = 0.0
        else:
            # ── Normal model path ─────────────────────────────────────────────
            log_ll, n_pred = self.compute_log_likelihood(password)
            nll            = -log_ll / n_pred if n_pred > 0 else 0.0
            log_p          = log_ll
            # For very long passwords this will underflow to 0.0 — that's fine;
            # it means the password is astronomically improbable (= very strong).
            joint_p = math.exp(log_p) if log_p > -700 else 0.0
            
            # Spongebob Case & Repetition Heuristic Penalties:
            # LSTMs can be tricked by strict alternating cases (e.g. "MaRkMyPaSsWoRd") 
            # or long repeating suffixes if the average NLL is pulled up by the prefix.
            if nll >= 1.5:
                import re
                # 1. Repeated character penalty (e.g., 'dddddd')
                if re.search(r'(.)\1{5,}', password):
                    nll = min(nll, 1.0)  # Force WEAK if 6+ repeating chars
                elif re.search(r'(.)\1{3,}', password):
                    nll = min(nll, 2.0)  # Max MODERATE if 4-5 repeating chars
                
                # 2. Spongebob Case substring penalty
                if password.isalpha():
                    cases = [c.islower() for c in password]
                    max_alt, curr_alt = 0, 0
                    for i in range(1, len(cases)):
                        if cases[i] != cases[i-1]:
                            curr_alt += 1
                            max_alt = max(max_alt, curr_alt)
                        else:
                            curr_alt = 0
                    
                    if max_alt >= 8:  # 8 consecutive case flips
                        nll = min(nll, 1.0)

        strength = self.get_strength_label(nll)

        return {
            "password":    password,
            "nll":         round(nll,  4),
            "joint_log_p": round(log_p, 4),
            "joint_p":     joint_p,
            "label":       strength.label,
            "color_hint":  strength.color_hint,
            "description": strength.description,
            "char_count":  len(password),
        }

    def score_batch(self, passwords: List[str]) -> List[dict]:
        """
        Score a list of passwords sequentially.

        Note: TFLite does not benefit from Python-level batching for LSTM
        models (each step is a single sequence), so this is a convenience
        wrapper around score().

        Parameters
        ----------
        passwords : List of password strings.

        Returns
        -------
        List of result dicts in the same order as the input.
        """
        return [self.score(pw) for pw in passwords]


# ---------------------------------------------------------------------------
# Interactive CLI for manual testing
# ---------------------------------------------------------------------------

def run_interactive(scorer: PasswordScorer) -> None:
    """
    Simple REPL that lets you type passwords and see their scores.
    Exits on empty input or Ctrl+C/Ctrl+D.
    """
    print("\n" + "═" * 60)
    print("  BLACKSITE NODE — Password Strength Evaluator (Offline ML)")
    print("  Type a password and press Enter.  Empty line to quit.")
    print("═" * 60 + "\n")

    while True:
        try:
            pw = input("  Password > ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n[Inference] Exiting.")
            break

        if not pw:
            break

        result = scorer.score(pw)

        bar_width  = 40
        nll_max    = 5.0  # cap for display purposes
        fill       = int(min(result["nll"] / nll_max, 1.0) * bar_width)
        bar        = "█" * fill + "░" * (bar_width - fill)

        label_pad  = result["label"].ljust(8)
        print(f"\n  Strength  : {label_pad}  [{bar}]")
        print(f"  NLL/char  : {result['nll']:.4f}")
        print(f"  log P(pw) : {result['joint_log_p']:.4f}")
        print(f"  Note      : {result['description']}")
        print()


# ---------------------------------------------------------------------------
# Batch benchmark helper
# ---------------------------------------------------------------------------

BENCHMARK_PASSWORDS = [
    # Definite WEAK passwords (known common patterns)
    "password",
    "123456",
    "password1",
    "qwerty",
    "letmein",
    "iloveyou",
    "admin123",
    # Moderate – rule-based transformations
    "P@ssw0rd",
    "P@ssw0rd!",
    "Tr0ub4dor&3",
    "Hunter2!",
    # Strong – high entropy
    "xK#9mP2$vQzL",
    "T7!rG@4wNpX2",
    "correct-horse-battery-staple",   # passphrase (long, but English words)
    "aB3$kL9!mP7@nQ2",
]


def run_benchmark(scorer: PasswordScorer) -> None:
    """Score the benchmark password list and print a formatted table."""
    print("\n" + "═" * 72)
    print(f"  {'Password':<30} {'NLL':>8}  {'Label':<10}  Description")
    print("─" * 72)

    for pw in BENCHMARK_PASSWORDS:
        result = scorer.score(pw)
        preview = pw[:28] + ".." if len(pw) > 28 else pw
        print(
            f"  {preview:<30} {result['nll']:>8.4f}  {result['label']:<10}  "
            f"{result['description'][:30]}"
        )

    print("═" * 72 + "\n")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Offline ML password strength inference using ONNX Runtime or TFLite."
    )
    p.add_argument(
        "--model",
        default="exports/password_model.onnx",
        help="Path to the .onnx or .tflite model file.",
    )
    p.add_argument(
        "--vocab",
        default="exports/vocab.json",
        help="Path to the vocab.json vocabulary file.",
    )
    p.add_argument(
        "--meta",
        default="exports/dataset_meta.json",
        help="Path to the dataset_meta.json metadata file.",
    )
    p.add_argument(
        "--threads",
        type=int,
        default=2,
        help="Number of CPU threads for inference (default: 2).",
    )
    p.add_argument(
        "--benchmark",
        action="store_true",
        help="Run the built-in benchmark password list instead of interactive mode.",
    )
    p.add_argument(
        "--password",
        type=str,
        default=None,
        help="Score a single password non-interactively (good for piping).",
    )
    p.add_argument(
        "--daemon",
        action="store_true",
        help="Run continuously in the background, accepting JSON on stdin and outputting JSON to stdout.",
    )
    return p.parse_args()


def main() -> None:
    args = parse_args()

    # Instantiate the scorer (loads model once).
    scorer = PasswordScorer(
        model_path=args.model,
        vocab_path=args.vocab,
        meta_path=args.meta,
        num_threads=args.threads,
    )

    if args.daemon:
        import sys
        # Tell the caller we are ready
        print("READY")
        sys.stdout.flush()
        
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
                pw = req.get("password", "")
                result = scorer.score(pw)
                # Output exactly one line of JSON
                print(json.dumps(result))
                sys.stdout.flush()
            except Exception as e:
                print(json.dumps({"error": str(e)}))
                sys.stdout.flush()
    elif args.password is not None:
        # Non-interactive single-password mode (pipe-friendly).
        result = scorer.score(args.password)
        print(json.dumps(result, indent=2))
    elif args.benchmark:
        run_benchmark(scorer)
    else:
        run_interactive(scorer)


if __name__ == "__main__":
    main()

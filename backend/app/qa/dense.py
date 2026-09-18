"""**Experimental.** Local dense (semantic) retrieval, for DS-QA-007.

Nothing in the production QA path imports this module, and nothing in it is
reachable from the API. It exists so the experiment can be measured and, if the
frozen adoption gate fails, deleted without trace (Phase 74). It is deliberately
*not* exported from `app.qa`.

## What it is for

DS-QA-006 established that five of twelve top-five misses are not reachable by
any lexical path: four cross-language (a Chinese question against an English
paper, where `unicode61` tokenization returns **zero rows**) and one English
synonym mismatch. Ranking cannot fix an absent candidate.

## Three properties that are load-bearing, and how each is guaranteed

**Canonical identity.** The corpus is built from :func:`app.qa.index._chunk_rows`
— the *same* function the FTS5 index is built from — so a dense hit and a lexical
hit for the same paragraph carry the same id, page, section and block ids by
construction rather than by agreement. Dense retrieval returns chunk ids and
nothing else; the existing metadata resolves page, section and bbox afterwards.

**Scope is a hard candidate constraint**, not a post-filter. The allowed id set is
computed by running the *same* SQL fragment the lexical path uses
(:func:`app.qa.retrieval._scope_clause`) against the same `chunks` table. Scoring
the whole document and filtering afterwards would let an out-of-scope paragraph
consume a rank slot and change what the in-scope evidence is compared against —
the mistake `retrieval.py` opens by naming.

**Determinism.** Ties break on canonical chunk id, exactly as `fuse()` does. The
same document, model, revision, query and scope give the same order.

## Privacy and cost

100% local. The model runs under `onnxruntime`'s CPU provider; no paragraph and no
question leaves the machine, and no provider credential is read. Embedding is the
only new dependency-free-except-`tokenizers` step; `torch`, `transformers` and
`sentence-transformers` are not used and are forbidden by AC-P1-07.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from app.document.models import DocumentIR
from app.logging import get_logger
from app.qa.index import _chunk_rows, index_path

logger = get_logger(__name__)

#: Recorded in the cache and in evidence. A change to any of these invalidates
#: every stored vector rather than silently mixing two embedding spaces.
EMBEDDING_MODEL = "intfloat/multilingual-e5-small"
EMBEDDING_REVISION = "main"
PIPELINE_VERSION = "1"

#: E5 is trained with these prefixes and its published usage requires them. They
#: are part of the model, not a tuning choice.
QUERY_PREFIX = "query: "
PASSAGE_PREFIX = "passage: "

#: XLM-R's positional limit. Longer paragraphs are truncated, which is recorded
#: as a known limitation rather than hidden.
MAX_TOKENS = 512

#: Encoding batch. Only affects speed.
BATCH_SIZE = 16

#: How many dense candidates join the fusion. Phase 51 — bounded, and not the
#: same thing as the final evidence depth (`DEFAULT_TOP_K`, unchanged at 8).
DENSE_CANDIDATES = 20

#: Where the ONNX weights live. Outside the repository, like every other model
#: this project runs (the layout model is cached the same way). Weights are never
#: committed.
CACHE_FILENAME = "embeddings.npz"


def model_dir() -> Path:
    """The directory holding `model.onnx` and `tokenizer.json`."""
    override = os.environ.get("APC_EMBEDDING_MODEL_DIR")
    if override:
        return Path(override)
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".cache")
    return (
        Path(base) / "academic-pdf-copilot" / "models"
        / EMBEDDING_MODEL.replace("/", "__") / "onnx"
    )


class DenseUnavailable(Exception):
    """Dense retrieval cannot run here.

    Raised rather than returning an empty list, so a caller cannot mistake
    "the embedding runtime is missing" for "nothing was semantically similar".
    Phase 46: lexical Paper QA must keep working when this is raised.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class DenseIndex:
    """Vectors for one document, in canonical chunk order."""

    ids: tuple[str, ...]
    vectors: np.ndarray  # (N, D) float32, L2-normalised
    built: bool
    build_seconds: float
    load_seconds: float

    @property
    def dimensions(self) -> int:
        return int(self.vectors.shape[1]) if self.vectors.size else 0

    @property
    def bytes_per_document(self) -> int:
        return int(self.vectors.nbytes + sum(len(i) for i in self.ids))


# --- the model -----------------------------------------------------------------

_session_lock = threading.Lock()
_session = None
_tokenizer = None


def _load_runtime():
    """Build the ONNX session and tokenizer once per process.

    `tokenizers` is imported here rather than at module scope on purpose: it is an
    *optional* dependency (AC-P1-07 / Phase 73), and a missing optional dependency
    must produce a clear, catchable error rather than an ImportError at the top of
    a module something else imported for another reason.
    """
    global _session, _tokenizer
    with _session_lock:
        if _session is not None:
            return _session, _tokenizer

        directory = model_dir()
        # Which artifact to load is configurable so the two builds can be
        # benchmarked against each other rather than one being assumed
        # equivalent. The default is the **published fp32** export: it is the
        # artifact the model actually is, and every capability number in this
        # experiment's evidence is measured against it.
        #
        # `model_int8.onnx` is a locally produced, dynamically quantized variant.
        # It is not the default because it is measurably worse — held-out Hit@1
        # 7/14 (fp32) against 6/14 (int8) — and it does not buy compliance with
        # AC-P1-06's 300 MB memory ceiling either (503 MB against 836 MB, ceiling
        # 300 MB). It is a cost/quality trade-off, opted into deliberately with
        # `APC_EMBEDDING_WEIGHTS=model_int8.onnx`, never a quiet substitute.
        weights = directory / os.environ.get("APC_EMBEDDING_WEIGHTS", "model.onnx")
        tokenizer_file = directory / "tokenizer.json"
        if not weights.is_file() or not tokenizer_file.is_file():
            raise DenseUnavailable(
                "MODEL_MISSING",
                f"Embedding weights are not present at {directory}. "
                "Run .agent/results/qa/fetch_model.py, or set APC_EMBEDDING_MODEL_DIR.",
            )

        try:
            import onnxruntime as ort
            from tokenizers import Tokenizer
        except ImportError as exc:  # pragma: no cover - depends on the install
            raise DenseUnavailable(
                "RUNTIME_MISSING",
                "Dense retrieval needs `onnxruntime` and `tokenizers`; install the "
                "`experiment` extra.",
            ) from exc

        tokenizer = Tokenizer.from_file(str(tokenizer_file))
        tokenizer.enable_truncation(max_length=MAX_TOKENS)
        tokenizer.enable_padding()

        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        session = ort.InferenceSession(
            str(weights), options, providers=["CPUExecutionProvider"]
        )
        _session, _tokenizer = session, tokenizer
        return _session, _tokenizer


def _encode(texts: list[str], *, is_query: bool) -> np.ndarray:
    """Embed a batch, mean-pooled over real tokens and L2-normalised.

    Normalisation is applied here, once, so nothing downstream can accidentally
    compare a normalised query against unnormalised documents (Phase 13). The
    similarity is then a plain inner product.
    """
    if not texts:
        return np.zeros((0, 0), dtype=np.float32)

    session, tokenizer = _load_runtime()
    prefix = QUERY_PREFIX if is_query else PASSAGE_PREFIX
    encodings = tokenizer.encode_batch([prefix + text for text in texts])

    ids = np.asarray([encoding.ids for encoding in encodings], dtype=np.int64)
    mask = np.asarray([encoding.attention_mask for encoding in encodings], dtype=np.int64)

    feeds = {"input_ids": ids, "attention_mask": mask}
    # XLM-R exports usually take `token_type_ids`; feed it only if the graph asks.
    input_names = {item.name for item in session.get_inputs()}
    if "token_type_ids" in input_names:
        feeds["token_type_ids"] = np.zeros_like(ids)
    feeds = {name: value for name, value in feeds.items() if name in input_names}

    hidden = session.run(None, feeds)[0]  # (B, L, D)

    expanded = mask[..., None].astype(np.float32)
    summed = (hidden * expanded).sum(axis=1)
    counts = np.clip(expanded.sum(axis=1), 1e-9, None)
    pooled = summed / counts

    norms = np.linalg.norm(pooled, axis=1, keepdims=True)
    return (pooled / np.clip(norms, 1e-12, None)).astype(np.float32)


def embed_query(question: str) -> np.ndarray:
    """The user's question, embedded as asked. Never rewritten first."""
    return _encode([question], is_query=True)[0]


#: The text a paragraph is embedded as. Decision I: the section title is prepended
#: because a paragraph's subject is often only in its heading — and the lexical
#: index already encodes that belief as `TITLE_WEIGHT`. Captions are embedded too,
#: because they are already first-class rows in the lexical index and a dense
#: corpus that disagreed with the lexical one would make the two arms
#: incomparable.
def passage_text(section_title: str, text: str) -> str:
    return f"{section_title}\n{text}" if section_title else text


def corpus(ir: DocumentIR) -> list[tuple[str, str]]:
    """`(chunk_id, passage_text)` for every unit the lexical index holds.

    Built from `_chunk_rows`, so this cannot drift from the lexical corpus: if a
    unit is added to or removed from the FTS5 index, it appears here too.
    """
    return [
        (row[0], passage_text(row[6], row[7]))
        for row in _chunk_rows(ir)
    ]


# --- the cache -----------------------------------------------------------------


def _cache_path(document_dir: Path) -> Path:
    return Path(document_dir) / CACHE_FILENAME


def _fingerprint(ir: DocumentIR, ids: list[str]) -> str:
    """What the cached vectors are only valid for (Phase 10/43).

    Every input that changes the numbers is in here: the text, the model, the
    revision, the pipeline. A mismatch rebuilds rather than mixing two embedding
    spaces in one matrix.
    """
    digest = hashlib.sha256()
    digest.update(ir.content_hash.encode("utf-8"))
    digest.update(EMBEDDING_MODEL.encode("utf-8"))
    digest.update(EMBEDDING_REVISION.encode("utf-8"))
    digest.update(PIPELINE_VERSION.encode("utf-8"))
    # **Which weights artifact**, not just which model. Dynamic int8
    # quantization produces vectors that differ from fp32's, so a cache built
    # from one must not be served to a session running the other: the mismatch
    # would be invisible, and would show up only as slightly wrong rankings. The
    # size is included because it changes whenever the artifact does.
    weights = model_dir() / os.environ.get("APC_EMBEDDING_WEIGHTS", "model.onnx")
    digest.update(weights.name.encode("utf-8"))
    digest.update(str(weights.stat().st_size if weights.is_file() else 0).encode("utf-8"))
    digest.update("\x1f".join(ids).encode("utf-8"))
    return digest.hexdigest()


def build_index(
    ir: DocumentIR, document_dir: Path, *, force: bool = False
) -> DenseIndex:
    """Return the document's vectors, building or reusing the cache.

    Phase 38 and 39 are two different measurements and are reported separately:
    `build_seconds` is the first-document cost, `load_seconds` the cached one.
    """
    document_dir = Path(document_dir)
    units = corpus(ir)
    ids = [unit_id for unit_id, _ in units]
    fingerprint = _fingerprint(ir, ids)
    path = _cache_path(document_dir)

    if path.is_file() and not force:
        try:
            started = time.perf_counter()
            with np.load(path, allow_pickle=False) as stored:
                if str(stored["fingerprint"][0]) == fingerprint:
                    vectors = np.asarray(stored["vectors"], dtype=np.float32)
                    if vectors.shape[0] == len(ids):
                        return DenseIndex(
                            ids=tuple(ids), vectors=vectors, built=False,
                            build_seconds=0.0,
                            load_seconds=(time.perf_counter() - started) * 1000,
                        )
        except (OSError, ValueError, KeyError):
            # A corrupt or foreign cache is a rebuild, never a crash.
            logger.warning("dense cache unreadable; rebuilding", extra={"path": str(path)})

    started = time.perf_counter()
    texts = [text for _, text in units]
    chunks = [
        _encode(texts[at : at + BATCH_SIZE], is_query=False)
        for at in range(0, len(texts), BATCH_SIZE)
    ]
    vectors = np.vstack(chunks) if chunks else np.zeros((0, 0), dtype=np.float32)
    build_seconds = time.perf_counter() - started

    document_dir.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        path,
        vectors=vectors,
        fingerprint=np.asarray([fingerprint]),
        model=np.asarray([EMBEDDING_MODEL]),
        revision=np.asarray([EMBEDDING_REVISION]),
        pipeline=np.asarray([PIPELINE_VERSION]),
        ids=np.asarray(ids),
    )
    logger.info(
        "dense index built",
        extra={"chunks": len(ids), "document_id": ir.document_id,
               "seconds": round(build_seconds, 2)},
    )
    return DenseIndex(
        ids=tuple(ids), vectors=vectors, built=True,
        build_seconds=build_seconds, load_seconds=0.0,
    )


# --- scope ---------------------------------------------------------------------


def allowed_ids(document_dir: Path, scope) -> set[str]:
    """The canonical ids a scope permits, using the lexical path's own rule.

    This calls `_scope_clause` rather than reimplementing page/section/selection
    membership. Two implementations of "is this paragraph on page 4" would
    eventually disagree about a paragraph spanning pages 4 and 5, and the
    disagreement would show up as evidence leaking out of a scope.
    """
    from app.qa.retrieval import _scope_clause

    clause, parameters = _scope_clause(scope)
    connection = sqlite3.connect(str(index_path(Path(document_dir))))
    try:
        rows = connection.execute(
            f"SELECT chunk_id FROM chunks WHERE 1 = 1 {clause}", list(parameters)
        ).fetchall()
    finally:
        connection.close()
    return {row[0] for row in rows}


# --- retrieval -----------------------------------------------------------------


@dataclass(frozen=True)
class DenseQuery:
    """One dense lookup, with the numbers an evaluation needs to attribute it."""

    order: tuple[str, ...]
    scores: tuple[tuple[str, float], ...]
    candidates_scored: int
    latency_ms: float


def rank(
    index: DenseIndex,
    question: str,
    *,
    allowed: set[str] | None = None,
    limit: int = DENSE_CANDIDATES,
    query_vector: np.ndarray | None = None,
) -> DenseQuery:
    """Rank the in-scope corpus against the question.

    `allowed=None` means "no scope constraint"; an **empty set means nothing is
    in scope**, which is a different thing and must not be read as "no
    constraint". Conflating the two is how a Page scope silently becomes a whole
    paper.
    """
    if not index.ids or index.vectors.size == 0:
        return DenseQuery((), (), 0, 0.0)

    started = time.perf_counter()
    vector = embed_query(question) if query_vector is None else query_vector
    similarities = index.vectors @ vector  # both sides are L2-normalised

    if allowed is not None:
        if not allowed:
            return DenseQuery((), (), 0, (time.perf_counter() - started) * 1000)
        mask = np.fromiter(
            (unit_id in allowed for unit_id in index.ids), dtype=bool, count=len(index.ids)
        )
        if not mask.any():
            return DenseQuery((), (), 0, (time.perf_counter() - started) * 1000)
        positions = np.flatnonzero(mask)
    else:
        positions = np.arange(len(index.ids))

    scored = positions[np.argsort(-similarities[positions], kind="stable")]
    # Ties break on canonical id, so a rerun cannot reorder equal candidates.
    ordered = sorted(
        scored.tolist(), key=lambda at: (-float(similarities[at]), index.ids[at])
    )[:limit]
    latency = (time.perf_counter() - started) * 1000

    return DenseQuery(
        order=tuple(index.ids[at] for at in ordered),
        scores=tuple((index.ids[at], float(similarities[at])) for at in ordered),
        candidates_scored=int(positions.size),
        latency_ms=latency,
    )


def describe() -> dict[str, object]:
    """Model identity, for the evidence record (Phase 6)."""
    directory = model_dir()
    weights = directory / os.environ.get("APC_EMBEDDING_WEIGHTS", "model.onnx")
    return {
        "model": EMBEDDING_MODEL,
        "revision": EMBEDDING_REVISION,
        "pipeline_version": PIPELINE_VERSION,
        "weights": weights.name,
        "model_dir": str(directory),
        "weights_bytes": weights.stat().st_size if weights.is_file() else 0,
        "tokenizer_bytes": (directory / "tokenizer.json").stat().st_size
        if (directory / "tokenizer.json").is_file() else 0,
        "runtime": "onnxruntime CPUExecutionProvider",
        "normalization": "L2-normalised, mean-pooled; similarity is an inner product",
    }

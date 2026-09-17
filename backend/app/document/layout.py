"""Page layout detection, without touching the upstream PDF library.

An isolation guard walks every module outside ``app/pdfkernel/`` and fails the
build if one imports the upstream library — and, outside the kernel, this file
may not even name it. That rule is why this module exists rather than a one-line
call to upstream's loader: the layout model is a plain ONNX graph, and running it
directly is the difference between Document Intelligence depending on a frozen
translation kernel and not depending on it.

The split of responsibility is deliberate:

* :func:`app.pdfkernel.adapter.ensure_layout_model` decides **whether the model
  is usable** — it is the existing pre-flight gate, and it is the one place that
  knows where the ~72 MiB file lives and that a missing mirror must not be
  allowed to kill the process.
* this module does the **inference**, because how a YOLO graph is pre- and
  post-processed is layout knowledge, not translation knowledge.

Measured facts about the model, verified against its own ONNX metadata rather
than assumed:

* It emits ``(1, 300, 6)`` — **non-maximum suppression happens inside the
  graph**, so there is no NMS to reimplement. Each row is
  ``[x0, y0, x1, y1, confidence, class_index]``.
* Boxes are in **image pixel space with a top-left origin, already in xyxy**.
  They need no y-flip; only a scale to PDF points.
* The label set is fixed at ten classes, read from the model metadata.
"""

from __future__ import annotations

import ast
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from app.document.models import (
    LAYOUT_ABANDON,
    LAYOUT_FIGURE,
    LAYOUT_FIGURE_CAPTION,
    LAYOUT_FORMULA_CAPTION,
    LAYOUT_ISOLATE_FORMULA,
    LAYOUT_PLAIN_TEXT,
    LAYOUT_TABLE,
    LAYOUT_TABLE_CAPTION,
    LAYOUT_TABLE_FOOTNOTE,
    LAYOUT_TITLE,
)

#: Fallback mapping if the model metadata is ever unreadable. The indices are the
#: model's own, confirmed against `custom_metadata_map["names"]`.
_DEFAULT_LABELS: dict[int, str] = {
    0: LAYOUT_TITLE,
    1: LAYOUT_PLAIN_TEXT,
    2: LAYOUT_ABANDON,
    3: LAYOUT_FIGURE,
    4: LAYOUT_FIGURE_CAPTION,
    5: LAYOUT_TABLE,
    6: LAYOUT_TABLE_CAPTION,
    7: LAYOUT_TABLE_FOOTNOTE,
    8: LAYOUT_ISOLATE_FORMULA,
    9: LAYOUT_FORMULA_CAPTION,
}

#: Matches the threshold the model's production consumer uses, so detection
#: behaviour is comparable rather than quietly different.
CONFIDENCE_THRESHOLD = 0.25

#: Padding value the model was trained with. A different value shifts every
#: activation in the letterbox border and changes detections near the edges.
PAD_VALUE = 114

STRIDE = 32

#: Two boxes are the same detection if their rectangles agree to within this
#: many points. Measured on a real page: the model emits duplicate rows at
#: different confidences (0.63/0.59 and 0.66/0.40 over identical rectangles),
#: which would otherwise double-count the same text.
_DUPLICATE_TOLERANCE_PT = 0.5


@dataclass(frozen=True)
class LayoutBox:
    """One detected region, in PDF points, top-left origin."""

    bbox: tuple[float, float, float, float]
    label: str
    confidence: float


def _read_labels(model_path: Path) -> dict[int, str]:
    """Read the class names the model carries in its own metadata.

    Preferred over the constant above: if the pinned model is ever replaced, its
    labels travel with it rather than drifting from a table in this file.
    """
    try:
        import onnx

        model = onnx.load(str(model_path), load_external_data=False)
        metadata = {entry.key: entry.value for entry in model.metadata_props}
        names = ast.literal_eval(metadata["names"])
        return {int(index): str(name) for index, name in names.items()}
    except Exception:  # noqa: BLE001 - any failure falls back to the known table
        return dict(_DEFAULT_LABELS)


class LayoutModel:
    """A loaded ONNX layout model. Loading is expensive; detection is not."""

    def __init__(self, session: object, labels: dict[int, str]) -> None:
        self._session = session
        self.labels = labels

    @classmethod
    def load(cls, model_path: Path) -> LayoutModel:
        import onnxruntime

        options = onnxruntime.SessionOptions()
        options.graph_optimization_level = (
            onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
        )
        # CPU only. This is a local-first desktop application; asking for a GPU
        # provider that is not present makes onnxruntime log a warning per run
        # for no benefit.
        session = onnxruntime.InferenceSession(
            str(model_path), options, providers=["CPUExecutionProvider"]
        )
        return cls(session, _read_labels(model_path))

    def detect(self, image: np.ndarray, page_width_pt: float, page_height_pt: float) -> list[LayoutBox]:
        """Detect layout regions in an RGB page image.

        ``image`` is ``(height, width, 3)`` uint8 at whatever resolution the
        caller rendered. Results come back in PDF points.
        """
        height_px, width_px = image.shape[:2]
        if height_px == 0 or width_px == 0:
            return []

        # Square input sized to the page height, aligned to the stride — the
        # shape the model was exported for and the one its consumer uses.
        target = max(STRIDE, int(height_px / STRIDE) * STRIDE)

        letterboxed = _letterbox(image, target)
        tensor = np.transpose(letterboxed, (2, 0, 1))[None, ...].astype(np.float32) / 255.0

        # Shape is (batch, detections, 6); batch is always 1 here, so the
        # leading axis is dropped rather than iterated — iterating it would
        # yield one (detections, 6) array and the row unpacking below would fail.
        predictions = self._session.run(None, {"images": tensor})[0][0]

        # Undo the letterbox so boxes are in the coordinates of the image we
        # were handed, then scale to points. Image pixels and points share a
        # top-left origin, so this is a pure scale — no flip.
        #
        # The shape used here must be the *actual* padded result, not the target
        # square. `_letterbox` only pads the stride remainder, so a tall page
        # comes out 608x832 rather than 832x832 — deriving the padding from the
        # square instead would compute 122px of left inset where there is 10,
        # and every box would land far off the page.
        new_h, new_w = letterboxed.shape[:2]
        gain = min(new_h / height_px, new_w / width_px)
        pad_x = round((new_w - width_px * gain) / 2 - 0.1)
        pad_y = round((new_h - height_px * gain) / 2 - 0.1)

        scale_x = page_width_pt / width_px
        scale_y = page_height_pt / height_px

        boxes: list[LayoutBox] = []
        for row in predictions:
            if float(row[4]) < CONFIDENCE_THRESHOLD:
                continue
            x0 = (float(row[0]) - pad_x) / gain * scale_x
            y0 = (float(row[1]) - pad_y) / gain * scale_y
            x1 = (float(row[2]) - pad_x) / gain * scale_x
            y1 = (float(row[3]) - pad_y) / gain * scale_y
            if x1 <= x0 or y1 <= y0:
                continue

            x0 = min(max(x0, 0.0), page_width_pt)
            x1 = min(max(x1, 0.0), page_width_pt)
            y0 = min(max(y0, 0.0), page_height_pt)
            y1 = min(max(y1, 0.0), page_height_pt)

            boxes.append(
                LayoutBox(
                    bbox=(x0, y0, x1, y1),
                    label=self.labels.get(int(row[5]), LAYOUT_PLAIN_TEXT),
                    confidence=float(row[4]),
                )
            )

        return _drop_duplicates(boxes)


def _drop_duplicates(boxes: list[LayoutBox]) -> list[LayoutBox]:
    """Collapse rectangles the model reported more than once.

    The graph suppresses overlapping boxes of the *same* class; it does not
    suppress the same rectangle found under two classes, and it does emit exact
    duplicates at different confidences. Left in, those would assign the same
    characters to two blocks and double-count the text. Highest confidence wins.
    """
    ordered = sorted(boxes, key=lambda box: box.confidence, reverse=True)
    kept: list[LayoutBox] = []
    for candidate in ordered:
        for existing in kept:
            if all(
                abs(a - b) <= _DUPLICATE_TOLERANCE_PT
                for a, b in zip(candidate.bbox, existing.bbox, strict=True)
            ):
                break
        else:
            kept.append(candidate)
    return kept


def _letterbox(image: np.ndarray, target: int) -> np.ndarray:
    """Scale the image to fit ``target`` and pad it to a square.

    Bilinear with half-pixel centres, which is what the reference
    implementation's `cv2.INTER_LINEAR` computes. Written with numpy rather than
    pulling in a computer-vision package for one resize: the graph's output
    tolerates the interpolation difference far more than the project tolerates a
    heavyweight undeclared dependency.
    """
    height, width = image.shape[:2]
    gain = min(target / height, target / width)
    resized_h = max(1, int(round(height * gain)))
    resized_w = max(1, int(round(width * gain)))

    resized = _resize_bilinear(image, resized_w, resized_h)

    pad_h = (target - resized_h) % STRIDE
    pad_w = (target - resized_w) % STRIDE
    top, left = pad_h // 2, pad_w // 2
    bottom, right = pad_h - top, pad_w - left

    padded = np.full((resized_h + top + bottom, resized_w + left + right, 3), PAD_VALUE, dtype=np.uint8)
    padded[top : top + resized_h, left : left + resized_w] = resized
    return padded


def _resize_bilinear(image: np.ndarray, new_w: int, new_h: int) -> np.ndarray:
    height, width = image.shape[:2]
    if (height, width) == (new_h, new_w):
        return image

    ys = (np.arange(new_h, dtype=np.float32) + 0.5) * (height / new_h) - 0.5
    xs = (np.arange(new_w, dtype=np.float32) + 0.5) * (width / new_w) - 0.5
    ys = np.clip(ys, 0.0, height - 1.0)
    xs = np.clip(xs, 0.0, width - 1.0)

    y0 = np.floor(ys).astype(np.int32)
    x0 = np.floor(xs).astype(np.int32)
    y1 = np.minimum(y0 + 1, height - 1)
    x1 = np.minimum(x0 + 1, width - 1)

    wy = (ys - y0)[:, None, None]
    wx = (xs - x0)[None, :, None]

    source = image.astype(np.float32)
    top = source[y0][:, x0] * (1 - wx) + source[y0][:, x1] * wx
    bottom = source[y1][:, x0] * (1 - wx) + source[y1][:, x1] * wx
    blended = top * (1 - wy) + bottom * wy
    return np.clip(blended + 0.5, 0, 255).astype(np.uint8)


# --- shared session -----------------------------------------------------------

_MODEL: LayoutModel | None = None
_MODEL_LOCK = threading.Lock()


def get_layout_model() -> LayoutModel:
    """The process-wide model, loaded once.

    Loading takes seconds and the graph is immutable, so one instance is shared.
    Guarded by a lock because extraction runs on worker threads and two
    concurrent loads would double a ~72 MiB allocation.
    """
    global _MODEL
    if _MODEL is not None:
        return _MODEL

    with _MODEL_LOCK:
        if _MODEL is None:
            from app.pdfkernel.adapter import ensure_layout_model

            _MODEL = LayoutModel.load(ensure_layout_model())
    return _MODEL


def reset_layout_model() -> None:
    """Drop the cached model. For tests, so a run starts from a known state."""
    global _MODEL
    with _MODEL_LOCK:
        _MODEL = None

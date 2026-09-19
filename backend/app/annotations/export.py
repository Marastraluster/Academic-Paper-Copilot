"""Notes out of the application, in two formats, deterministically.

The whole module rests on one distinction that the rest of the codebase already
makes and that this file must not blur:

    the user's writing is theirs and is exported **exactly**
    the source quote is the paper's and is exported **as evidence of what was marked**

So a note's text is never trimmed, re-wrapped, translated or spell-corrected on
the way out. Search normalisation is a query-time representation; it must not
reach the bytes a reader takes away with them.

## Why the server generates this

The browser's `AnnotationView` deliberately carries no `source_anchor_id` — the
backend's `summary()` withholds it because a digest identifies a source region to
the server and a reader has no use for one. A machine-readable export whose whole
purpose is to survive a re-extraction has to preserve that anchor, so it has to be
produced where the anchor is. Both formats are produced here rather than splitting
Markdown to the client and JSON to the server: one ordering, one field set, one
place to be wrong.

## What it does not do

No extraction. Reading the cached IR when one already exists enriches the export
with the paper's title and its sections; **producing** one is a fourteen-second
ONNX pass that a download must never pay for. This is the same boundary
DS-QA-010-FIX-001 drew for the notes list, and it is load-bearing for the same
reason.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone

from app.annotations.models import Annotation, AnnotationTarget
from app.annotations.service import resolve_annotation
from app.document.models import DocumentIR

#: The export format's own version, and **not** the IR pipeline version.
#:
#: They change for different reasons: the IR pipeline version moves when the
#: extraction improves, the export schema moves when the file a user archived
#: stops meaning what it meant. A consumer reading `schema_version` cares only
#: about the second, and coupling them would invalidate every archived file the
#: day a layout constant moved.
NOTES_EXPORT_SCHEMA_VERSION = "1"

#: Characters no filesystem agrees on, plus control characters.
_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
#: Whitespace, which the worked example in the criteria replaces with `_` too.
_WHITESPACE = re.compile(r"\s+")

MAX_STEM_CHARS = 100


@dataclass(frozen=True)
class ExportEntry:
    """One annotation, prepared once and rendered by both formats.

    Prepared rather than rendered twice on purpose: Markdown and JSON that
    disagree about an annotation's pages or its resolution state would be a bug
    nobody notices until someone diffs an archive against a document.
    """

    annotation: Annotation
    #: The worst state across this annotation's targets: what the reader is told
    #: when one answer has to stand for the whole span.
    state: str
    #: Each target's **own** state, by target id.
    #:
    #: Kept separate from `state` because collapsing them loses the one thing an
    #: archive is for. An annotation whose first paragraph placed exactly and
    #: whose second did not must export both facts; recording the worst against
    #: both targets would claim the first is uncertain when it is not, and a
    #: future import would have no way to recover what was actually known.
    target_states: dict[str, str]
    page_first: int
    page_last: int
    section: str | None


def sanitize_stem(name: str) -> str:
    """A filename a filesystem will accept, from whatever the PDF was called.

    Non-ASCII is preserved: a paper called 深度学习 is a paper whose export the
    reader should be able to recognise. What is replaced is the set of characters
    that are actually unsafe, not the set of characters that are unfamiliar.

    The edge whitespace is trimmed **before** substitution rather than after, so
    that a trailing `_` produced by an unsafe character survives. Stripping
    underscores afterwards would quietly delete the last character of a name
    rather than sanitise it, and the criteria's worked example is exactly this
    case.
    """
    stem = name
    if stem.lower().endswith(".pdf"):
        stem = stem[:-4]
    stem = stem.strip()
    stem = _UNSAFE.sub("_", stem)
    stem = _WHITESPACE.sub("_", stem)
    stem = stem[:MAX_STEM_CHARS]
    # A name built entirely from replaced characters has nothing left to
    # recognise — `___-notes.md` is a file the reader has to rename — so it falls
    # back like an empty one. Checked without stripping, so a trailing `_` that
    # came from a real character is still kept.
    return stem if stem.strip("_") else "document"


def export_filename(name: str, extension: str) -> str:
    return f"{sanitize_stem(name)}-notes.{extension}"


def _sorted(annotations: list[Annotation]) -> list[Annotation]:
    """Canonical source order, then creation order as the tie-break.

    The same order the panel shows. A reader looking for the note they made
    "about the method section" is looking in the paper's order; the order they
    happened to write things in is not something they remember, and a relevance
    score invented here would be a second answer to a settled question.
    """

    def key(annotation: Annotation) -> tuple:
        first = annotation.targets[0] if annotation.targets else None
        page = first.page_number if first else 0
        top = first.rects[0][1] if first and first.rects else 0.0
        return (page, top, annotation.created_at, annotation.id)

    return sorted(annotations, key=key)


def _section_for(ir: DocumentIR | None, page: int) -> str | None:
    """The section a page falls in, when a *cached* IR can already say.

    Deliberately tolerant: a document whose IR has no sections, or no IR at all,
    still exports. Section metadata is enrichment, and an export that failed
    because the paper had not been read would be the FIX-001 defect wearing a new
    hat.
    """
    if ir is None:
        return None
    candidates = [
        section
        for section in ir.sections
        if section.page_range[0] <= page <= section.page_range[1]
    ]
    return candidates[-1].title if candidates else None


def prepare(
    annotations: list[Annotation],
    *,
    ir: DocumentIR | None = None,
    store=None,
) -> list[ExportEntry]:
    """Resolve and order the annotations an export will contain.

    Soft-deleted rows are the caller's to exclude — `list_for_content` already
    does it — and are not filtered again here, because a second filter that
    silently agrees with the first is a second place for the two to disagree.
    """
    entries: list[ExportEntry] = []
    for annotation in _sorted(annotations):
        resolved = resolve_annotation(ir, annotation, store=store) if ir else ()
        target_states = {
            item.target.id: item.state.value for item in resolved
        }
        # Worst-first, so an annotation with one exactly-placed target and one
        # that could not be placed is reported as the weaker of the two: the
        # reader is being told what is uncertain, and understating that is the
        # failure that matters.
        state = next(
            (
                candidate
                for candidate in ("ORPHANED", "AMBIGUOUS", "REATTACHED", "EXACT")
                if candidate in set(target_states.values())
            ),
            "UNRESOLVED",
        )
        pages = [t.page_number for t in annotation.targets] or [0]
        first_page = min(pages)
        entries.append(
            ExportEntry(
                annotation=annotation,
                state=state,
                target_states=target_states,
                page_first=first_page,
                page_last=max(pages),
                section=_section_for(ir, first_page),
            )
        )
    return entries


# --- Markdown -----------------------------------------------------------------


def _markdown_quote(text: str) -> str:
    """Every line of the quote becomes its own blockquote line.

    A quote containing a newline would otherwise end the blockquote and drop the
    rest of the paper's text into the document body, where it reads as the
    exporter's own prose.
    """
    lines = text.splitlines() or [""]
    return "\n".join(f"> {line}" for line in lines)


#: A structure-opening token **at the start of a line**, which is the only place
#: any of them means anything in Markdown.
_LINE_MARKER = re.compile(
    r"^(?P<indent>[ \t]*)(?P<marker>#{1,6}(?=\s)|>|```|~~~|\||[-*+](?=\s)|\d+[.)](?=\s))",
    re.MULTILINE,
)


def _escape_block(text: str) -> str:
    """Neutralise the line-leading tokens that would restructure the file.

    **Position-aware, and that is the whole point.** A `>` in the middle of a
    line is an ordinary character; only a leading one opens a blockquote. The
    naive version escaped every occurrence, which turned a note containing
    `<script>alert(1)</script>` into `<script\\>alert(1)</script\\>` — corrupting
    the reader's text in order to protect a file that was never in danger. The
    criteria forbid exactly that: escape safely, never delete or rewrite what the
    user wrote.

    The tokens that matter are the ones that can swallow what follows: a heading
    re-levels every later entry, and an unterminated code fence hides them
    entirely. Escaping those, and nothing else, keeps a technical note full of
    `*`, `|` and `#` mid-sentence readable.
    """
    return _LINE_MARKER.sub(lambda match: f"{match.group('indent')}\\{match.group('marker')}", text)


def render_markdown(
    entries: list[ExportEntry],
    *,
    title: str,
    filename: str,
    content_hash: str,
    exported_at: str,
) -> str:
    lines = [
        f"# Notes: {title}",
        "",
        f"- **Document:** {filename}",
        f"- **Content hash:** {content_hash}",
        f"- **Exported:** {exported_at}",
        f"- **Annotations:** {len(entries)}",
        "",
    ]
    if not entries:
        lines.append("_This document has no notes._")
        lines.append("")
        return "\n".join(lines)

    for index, entry in enumerate(entries, start=1):
        annotation = entry.annotation
        kind = "Note" if annotation.kind == "note" else "Highlight"
        lines.append(f"## {index}. {kind}")
        lines.append("")
        location = (
            f"**Page:** {entry.page_first}"
            if entry.page_first == entry.page_last
            else f"**Pages:** {entry.page_first}–{entry.page_last}"
        )
        lines.append(location)
        if entry.section:
            lines.append(f"**Section:** {_escape_block(entry.section)}")
        if entry.state != "EXACT":
            lines.append(f"**Status:** {entry.state}")
        lines.append(f"**Created:** {annotation.created_at}")
        lines.append(f"**Updated:** {annotation.updated_at}")
        lines.append("")
        lines.append(_markdown_quote(annotation.quote))
        lines.append("")
        if annotation.comment:
            # Under a label, never merged into the blockquote: the reader must be
            # able to tell their own sentence from the paper's at a glance.
            lines.append("**Note:**")
            lines.append("")
            lines.append(_escape_block(annotation.comment))
            lines.append("")
        if len(annotation.targets) > 1:
            lines.append(f"<sub>{len(annotation.targets)} source locations</sub>")
            lines.append("")
    return "\n".join(lines)


# --- JSON ---------------------------------------------------------------------


def _target_payload(target: AnnotationTarget, state: str) -> dict:
    """`state` is this **target's** own, not the annotation's."""
    """One target, as the archive will keep it.

    `source_anchor_id` and `anchor_version` are the identity and are always
    present. `original_bbox`, `rects`, `prefix` and `suffix` are what a future
    importer would need to place the annotation again without re-deriving
    anything. There is deliberately **no runtime paragraph id** here: it is an
    ordinal into one extraction, and DS-DOC-002 measured one constant renumbering
    145 of 160 paragraphs of a paper whose bytes had not changed. The current
    resolution is reported beside the anchor as a state, never as an identity.
    """
    return {
        "target_order": target.target_order,
        "source_anchor_id": target.source_anchor_id,
        "anchor_version": target.anchor_version,
        "page_number": target.page_number,
        "original_bbox": list(target.original_bbox),
        "rects": [list(rect) for rect in target.rects],
        "exact_quote": target.exact_quote,
        "prefix": target.prefix,
        "suffix": target.suffix,
        "resolution_state": state,
    }


def to_export_dict(
    entries: list[ExportEntry],
    *,
    document_id: str,
    filename: str,
    content_hash: str,
    exported_at: str,
) -> dict:
    return {
        "schema_version": NOTES_EXPORT_SCHEMA_VERSION,
        "exported_at": exported_at,
        "document": {
            "document_id": document_id,
            "filename": filename,
            "content_hash": content_hash,
        },
        "annotations": [
            {
                "id": entry.annotation.id,
                "kind": entry.annotation.kind,
                "color": entry.annotation.color,
                "quote": entry.annotation.quote,
                "comment": entry.annotation.comment,
                "created_at": entry.annotation.created_at,
                "updated_at": entry.annotation.updated_at,
                "resolution_state": entry.state,
                "page_first": entry.page_first,
                "page_last": entry.page_last,
                "targets": [
                    _target_payload(
                        target,
                        entry.target_states.get(target.id, entry.state),
                    )
                    for target in entry.annotation.targets
                ],
            }
            for entry in entries
        ],
    }


def render_json(payload: dict) -> str:
    """Serialised by the stdlib, never by string concatenation.

    `ensure_ascii=False` because a Chinese note that came back as `\\u4f60\\u597d`
    would round-trip correctly and be useless to read; the file is declared UTF-8
    and the bytes match. `indent=2` so a human diff of two archives is possible —
    which is also what makes the structural determinism test meaningful.
    """
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False) + "\n"


def now_iso() -> str:
    """ISO 8601, UTC, second precision.

    Second precision on purpose: sub-second digits would make two exports of
    unchanged data differ for no reader-visible reason, which is exactly the
    determinism this format is supposed to have.
    """
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()

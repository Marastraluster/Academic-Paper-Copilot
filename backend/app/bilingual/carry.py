"""A translation outlives the extraction it was made from.

A reading is stored by paragraph id, and paragraph ids belong to one extraction:
parse the paper again — a better converter, MinerU instead of the in-house
extractor — and every id moves. The stored reading then addresses paragraphs
that no longer exist, and until this module the reader was simply asked to pay
for the whole paper again.

But most of the *sentences* did not change. So when the paper has a reading
from another extraction and none for this one, each paragraph whose source text
is the same (spacing aside) takes its translation across. If that covers the
paper, the reading is complete again at no cost; otherwise what was carried is
kept as work in progress, and a resumed job translates only the paragraphs that
really are new.

Nothing here reaches a provider.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

from app.bilingual.cache import (
    read_bilingual,
    read_bilingual_of_any_extraction,
    read_partial,
    write_bilingual,
    write_partial,
)
from app.bilingual.pipeline import assemble, heading_views_for, plan
from app.document.models import DocumentIR


def _same(text: str) -> str:
    """Text as compared: spacing is an extractor's choice, the words are the paper's."""
    return re.sub(r"\s+", " ", text).strip()


def carry_over(ir: DocumentIR, documents_dir: Path, target_language: str) -> int:
    """Bring a reading made from another extraction across to this one.

    Returns how many paragraphs were carried; ``0`` when there was nothing to do
    (this extraction already has a reading or work in progress, or the paper has
    no other reading, or none of its sentences match).
    """
    identity = dict(
        content_hash=ir.content_hash,
        ir_pipeline_version=ir.pipeline_version,
        target_language=target_language,
    )
    if read_bilingual(documents_dir, **identity) is not None:
        return 0
    if read_partial(documents_dir, **identity) is not None:
        return 0
    old = read_bilingual_of_any_extraction(
        documents_dir, content_hash=ir.content_hash, target_language=target_language
    )
    if old is None or old.ir_pipeline_version == ir.pipeline_version:
        return 0

    by_text = {
        _same(paragraph.source_text): paragraph.translated_text
        for paragraph in old.paragraphs
        if paragraph.is_readable()
    }
    work = plan(ir)
    translated = {
        paragraph.id: by_text[key]
        for batch in work.batches
        for paragraph in batch.paragraphs
        if (key := _same(paragraph.text)) in by_text
    }
    if not translated:
        return 0
    titles = {
        _same(section.title): section.title_translated
        for section in old.sections
        if section.title_translated
    }
    headings = {
        section.id: titles[key] for section in work.headings if (key := _same(section.title)) in titles
    }

    total = sum(len(batch.paragraphs) for batch in work.batches)
    if len(translated) == total:
        artifact = assemble(
            ir, work, heading_views_for(work), translated, headings,
            target_language=target_language,
            provider_model=old.provider_model,
            provider_base_url=old.provider_base_url,
            created_at=datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        )
        if artifact.is_usable():
            write_bilingual(documents_dir, artifact)
            return len(translated)
    write_partial(
        documents_dir, translated=translated, headings=headings,
        provider_model=old.provider_model, **identity,
    )
    return len(translated)

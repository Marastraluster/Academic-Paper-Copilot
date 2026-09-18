You are the independent Acceptance Criteria author for a local-first academic PDF
reader + bilingual translator ("Academic PDF Copilot"). You are Gemini; the lead
engineer is DeepSeek, who will implement what you specify. You define the criteria;
you do not write production code.

Your criteria for the previous fifteen tasks have been used as written, and you
have corrected a false premise in our briefs more than once. Do that again if you
find one here — including if the measurement below contradicts the framing our own
brief put on this task.

# The task

DS-QA-004 — Retrieval Recall Improvement. Paper QA's retrieval is lexical (SQLite
FTS5 + BM25). It misses questions whose vocabulary differs from the paper's, and a
user sees the miss as "the paper does not say". Improve recall **without** weakening
grounding: no answering from model memory, no forced answerability, and abstention
must stay a correct outcome when the evidence genuinely is not there.

# What exists, measured today

## Retrieval, as implemented

`app/qa/query.py` — sanitisation and deterministic expansion:

```python
def normalize_terms(query: str) -> list[str]:
    """Split into quoted FTS5 terms. Each word is quoted, so no user input can
    be read as an operator."""

def expand(query: str, analysis: DocumentAnalysis | None) -> list[tuple[str, str, str]]:
    """(term, expanded_to, source). Two kinds, both lookups:
       glossary:  entry.suggested_translation -> entry.source_term   ("glossary")
       acronym:   entry.acronym -> entry.expansion  (only when non-None) ("acronym")
    Longest match first; a term already covered by a longer match is skipped."""

def prepare(query, analysis=None) -> PreparedQuery:
    # base = ' OR '.join(normalize_terms(query))
    # each expansion joins as an ALTERNATIVE, never a conjunct:
    #   "(base) OR (expansion1) OR (expansion2)"
```

`app/qa/index.py` — one SQLite file per document at
`<documents_dir>/<id>/search.db`, FTS5 table `chunks` with columns
`chunk_id UNINDEXED, kind UNINDEXED, section_id UNINDEXED, page_number UNINDEXED,
page_range UNINDEXED, block_ids UNINDEXED, section_title INDEXED, text INDEXED`,
tokenizer `unicode61`, and `BM25_EXPRESSION = bm25(chunks, 0,0,0,0,0,0, 5.0, 1.0)`
(section title 5.0, body 1.0). Index rows: one per `ParagraphIR`, plus one per
figure/table caption; headings are **not** rows — a heading is carried as the
`section_title` column of the paragraphs it governs. `abandon` is not indexed.

`app/qa/retrieval.py`:

```python
DEFAULT_TOP_K = 8
NEIGHBOUR_RADIUS = 1

def retrieve(ir: DocumentIR, document_dir: Path, *, query: str, scope: Scope,
             analysis: DocumentAnalysis | None = None, top_k: int = DEFAULT_TOP_K,
             max_items: int | None = None) -> EvidenceBundle
```

Scope (`whole_paper` / `section` / `page` / `selection`) constrains **candidate
generation inside the SQL MATCH**, not the results afterwards. Neighbour expansion
runs after ranking, within the same section, and is skipped entirely for
`selection`. Each `EvidenceItem` carries `id` ("E1"), `chunk_id`, `paragraph_id`,
`section_id`, `section_title`, `page_number`, `page_range`, `block_ids`, `text`
(verbatim), `score`, `is_direct_hit`, `is_caption`.

`app/qa/models.py` — `DocumentAnalysis` in `app/context/models.py`:

```python
class GlossaryEntry(BaseModel):   source_term: str; suggested_translation: str|None
                                  definition: str|None; is_translatable: bool = True
                                  category: str|None; paragraph_ids: list[str]
                                  confidence: float|None
class AcronymEntry(BaseModel):    acronym: str; expansion: str|None; paragraph_ids: list[str]
class EntityEntry(BaseModel):     name: str; kind: str; paragraph_ids: list[str]
class SectionAnalysis(BaseModel): section_id: str; title: str; summary: str
                                  page_range: tuple[int,int]; synthetic: bool = False
class DocumentAnalysis(BaseModel): domain, summary, sections, glossary, acronyms,
                                   entities, errors, provenance, status
```

**Real data, from the ResNet paper's stored analysis** — 207 glossary entries (167
translatable), 29 acronyms of which **only 5 have an expansion** (the analysis
leaves the rest `None` because the paper never spells them out), and 56 entities:

```
model      34    (residual networks, VGG nets, Plain Network, 34layer baseline, …)
dataset     6    (ImageNet, CIFAR-10, COCO, …)
benchmark   6    (ILSVRC, ILSVRC 2015 classification task, …)
metric      6
framework   4
```

Every entity and glossary entry carries `paragraph_ids` — the paragraphs it was
found in. That is an available salience signal.

## The measured failure taxonomy — this is the finding that should shape your gates

Two benchmarks. The first (ResNet + Diffusion Policy, 20 questions) has been read
repeatedly during development and is a **diagnostic** set. The second is **held
out**: PPO (Schulman et al. 2017), 12 pages, 47 paragraphs, whose 13 questions and
their gold phrases were authored by reading the extracted text **before any
retrieval was run against it**. The script refuses to run if a gold phrase is
absent from the paper or an unanswerable question names a term the paper contains.

```
set        mode        Hit@1  Hit@3  Hit@5  Hit@10
ResNet     raw          50%    60%    60%     70%      (10 questions)
ResNet     assisted     60%    70%    70%     80%
DiffPolicy raw/assisted 50%    50%    60%     90%      (10 questions, no analysis)
PPO        raw          38%    62%    62%     62%      (13 questions, no analysis)
```

Held-out, by class:

```
class             n   Hit@1  Hit@3  Hit@5  Hit@10
EXACT_TERM        3     67%    67%    67%     67%
ENTITY_TYPE       2     50%   100%   100%    100%
PARAPHRASE        3     33%    67%    67%     67%
ACRONYM           1      0%   100%   100%    100%
CROSS_LANGUAGE    3      0%     0%     0%      0%
METRIC            1    100%   100%   100%    100%
ALL              13     38%    62%    62%     62%
```

Classifying **every miss at Hit@5 across both sets** (13 misses in 33 questions):

```
CROSS_LANGUAGE     5   a Chinese question against an English paper with no
                       analysis retrieves *nothing at all* — the characters match
                       no token in the index. One ResNet case is fixed by the
                       glossary when an analysis exists; the rest are not.
PARAPHRASE         5   "How does the method limit how far the policy may change in
                       one update?" vs the paper's "constraint on the size of the
                       policy update". "Why does increasing depth hurt plain
                       networks?" ranks the answering paragraph 9th.
ENTITY_TYPE        1   "What datasets are used?" vs CIFAR-10 / ImageNet / COCO.
LEXICAL_SYNONYM    1   "What optimization method is used?" vs SGD / momentum.
EXACT_TERM         1   "What is Algorithm 1 in this paper?" — the gold paragraph is
                       titled "Algorithm 1 PPO" and four common words outvoted it.
```

**Our brief called entity-type expansion "the most important deterministic
experiment". The measurement says it is 1 miss in 13.** Cross-language and
paraphrase are 10 of 13 between them, and neither is reachable by appending
metadata to a lexical query — a Chinese question shares no token with an English
index, and a paraphrase shares no token with the paper's phrasing. Tell us if you
read this differently; if not, the gates should reflect it.

## Hard constraints

* **No mandatory pre-analysis.** `DocumentAnalysis` costs hundreds of seconds on a
  real paper. Paper QA must stay usable on a freshly uploaded PDF with no analysis.
* **No embeddings, no vector database, no new AI SDK, no new provider abstraction** —
  unless your own frozen gate says the measured evidence justifies it, and it does
  not today.
* **No answer-generation redesign.** DS-QA-002's semantics are frozen: `ANSWERED` /
  `PARTIAL` / `INSUFFICIENT_EVIDENCE`, citations resolved by the application, the
  counterfactual grounding property (3/3 reported swapped evidence, 0/3 from
  memory), and 16/16 abstention on deliberately unanswerable questions.
* **No benchmark-specific hardcoding.** No paper, dataset, model or question from
  either benchmark may appear in retrieval logic.
* **Scope stays enforced during candidate generation**, for every query a strategy
  issues — a rewritten query must not search globally and filter afterwards.
* Provider infrastructure is reused as it stands; a rewrite failure must degrade to
  local lexical retrieval, never to a failed question.

# What you must decide

Define **P0 / P1 / P2** criteria, each with a verifiable assertion, and define
**go/no-go gates** for the three stages:

```
Stage A  deterministic expansion from metadata that already exists
         (glossary, acronyms, entities, entity types — no model call)
Stage B  bounded LLM query rewriting, 2-4 source-language lexical variants,
         retrieved independently and fused
Stage C  hybrid semantic retrieval (embeddings / vector store)
```

And answer explicitly:

**A.** What evidence is required before adding LLM query rewriting? Given that
deterministic expansion can only touch 2 of the 13 measured misses, is that
evidence already in hand, or is a Stage A measurement still required first?

**B.** What evidence would be required before adding embeddings? What would have to
remain failing after Stages A and B, and at what product cost?

**C.** How should multiple lexical queries be fused? Reciprocal Rank Fusion is the
obvious candidate — say whether it is acceptable here, what `k` should be, and what
the deduplication identity must be (paragraph identity, not text: a paper repeats
its own sentences and two distinct paragraphs must not be merged).

**D.** Should entity-type expansion run when no `DocumentAnalysis` exists? If it
should, where would the entities come from — and if it should not, is that an
acceptable product state given that a freshly uploaded paper has no analysis?

**E.** "What datasets are used?" must not dump all 34 model entities (or every
glossary term) into the query. Specify the bound: how many expansions, chosen by
what rule, from what signal. `paragraph_ids` gives occurrence counts; `kind` gives
the type. Say which you would use and what the failure mode of the bound is.

**F.** How do we prevent tuning to the benchmark? State the rule you will hold the
implementation to — and say what evidence you would require before accepting a
change that improves one benchmark and not the other.

Cover at least: unchanged raw baseline; deterministic expansion; glossary; acronyms;
entities; entity-type expansion and its bound; cross-language with and without
analysis; the analysis-present and analysis-absent paths; a non-provider fallback;
multi-query retrieval and fusion; duplicate merging by paragraph identity;
paragraph/page/section identity preservation; captions; references; top-k; scope
filtering for every issued query; Selection staying out of scope; latency; token
cost; benchmark reproducibility; the held-out set; no QA-hallucination regression;
abstention staying valid; tests; and what a real sidebar verification must show.

Where you disagree with this brief, say so and say why. If you judge that some
numbered item above is not worth implementing, say that too, and say what evidence
would change your mind.

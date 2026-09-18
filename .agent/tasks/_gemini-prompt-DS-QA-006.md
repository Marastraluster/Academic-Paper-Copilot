You are the independent Acceptance Criteria author for a local-first academic PDF
reader + bilingual translator ("Academic PDF Copilot"). You are Gemini; the lead
engineer is DeepSeek, who will implement what you specify. You define the criteria;
you do not write production code.

Your criteria for the previous seventeen tasks have been used as written, and you
have corrected a false premise in our briefs more than once — including, last task,
being right that a bounding rect is wrong for two columns while our brief was
vague. Do that again if you find one here. The measurements below were taken
before this brief was written and they **change the shape of the task**; tell us if
you read them differently.

# The task

DS-QA-006 — Retrieval Ranking Refinement. Given the candidates we already
retrieve, rank the genuinely useful source evidence into the answer model's bounded
evidence window more reliably. Explicitly **not**: embeddings, a vector store, an
LLM reranker, a new query-understanding model, answer-generation changes, or
multi-turn. Ranking operates over candidates the existing pipeline already found.

# What was measured before writing this brief

## The premise, tested

The task brief asserts that some failed queries "already have the correct source
evidence at approximately rank 6–8". That is a claim about the **candidate pool**,
and the current benchmark cannot test it: it reports the final rank after fusion,
neighbour expansion and a top-k cut, so "ranked 9th" and "never retrieved" are
indistinguishable. A diagnosis script (`rank_diagnosis.py`) opens the index the same
way `retrieve` does, runs each query variant independently with the real SQL, and
records where the gold actually is.

**33 questions** (20 development across ResNet and Diffusion Policy, 13 held-out on
PPO). **12 are outside the top five**:

```
NOT_RETRIEVED     5   4 cross-language (a Chinese query against an English index
                      retrieves zero rows by construction) + 1 English lexical
                      synonym: "What optimization method is used?" — nothing
                      retrieves the paragraph that says "momentum".
SINGLE_LIST_RANK  6   the gold is in the pool at ranks 6–13, and the fused rank is
                      *identical to the best single variant's rank*.
QUERY_PATH_COMPETITION 1  fusion moved it down: the entity variant ranked the gold
                      5th and fusing with the raw list pushed it to 8th.
```

Per-question, the interesting part:

```
question                                 fused  best-variant  per-variant ranks
What datasets are used for evaluation?       8        5         raw:11 entity1:- entity2:5
Why does increasing depth hurt plain nets?   9        9         raw:9
How is a robot policy represented?          10       10         raw:10
What role does diffusion play...?            9        9         raw:9
How is a rollout defined?                    6        6         raw:6
What is Algorithm 1 in this paper?          13       13         raw:13
How does the method limit how far...?       11       11         raw:11
```

**Six of the seven ranking-class misses have `fused == best_variant`.** Fusion is
not displacing them; the single BM25 list already ranks them 6th–13th. And they are
*inside the candidate pool* — `PER_QUERY_CANDIDATES = 20` — so retrieving deeper
does not reach them either. Whatever fixes these has to be a **better ranking
within the pool**, not more candidates and not better fusion.

## Would any deterministic signal actually lift them?

`signal_probe.py` takes each of the 12 misses, sorts its candidate pool by a signal,
and asks whether the gold enters the top five:

```
coverage       4/12    the fraction of the question's content words present in the
                       candidate — BM25 sums term frequencies, so a long paragraph
                       full of common words can outrank a short one that matches
                       more of what was asked
phrase         0/12    the question's longest verbatim phrase
path_count     0/12    how many independent variants retrieved it
```

The four coverage lifts are real: *"How is a robot policy represented?"* 10 → 3,
*"How is a rollout defined?"* 6 → 3, *"What is Algorithm 1 in this paper?"* 13 → 1,
*"What role does diffusion play…"* 9 → 5.

The three it does **not** fix are the long, many-term questions (*"Why does
increasing depth hurt plain networks?"*, *"How does the method limit how far the
policy may change in one update?"*, *"What datasets are used for evaluation?"*),
where coverage normalises over enough terms that the gold no longer separates.

**Phrase matching lifting nothing is worth pausing on**: the phrase signal fires
widely — "plain networks" appears in many ResNet paragraphs — so an exact-phrase
boost would reward a common phrase as much as a distinctive one. That is evidence
against the boost the brief's §17 suggests, and we would rather hear that from you
than discover it later.

## The existing implementation, as it is

`app/qa/fusion.py`:

```python
RRF_K = 60                     # Cormack et al.
PER_QUERY_CANDIDATES = 20      # candidates taken per query before fusion
RRF(d) = Σ 1 / (RRF_K + rank)  # rank starts at 1
# ties broken by chunk key, so the order is identical every run
```

`app/qa/retrieval.py`:

```python
DEFAULT_TOP_K = 8
NEIGHBOUR_RADIUS = 1
```

Each `QueryVariant` is its own FTS5 query, fused by RRF; `_expand_neighbours` then
adds one paragraph either side, in the same section, and the bundle is cut to
`top_k`. `EvidenceItem` carries `score`, `is_direct_hit`, `page_number`,
`paragraph_id`, `block_ids`, `is_caption`.

## Debt this task owns

`EvidenceItem.score` **no longer has one meaning**: with a single variant it carried
a BM25 value and now it carries an RRF value, and DS-QA-004 documented the change in
a docstring rather than in the type. The brief calls this out and permits a minimal
cleanup, because ranking semantics are this task's subject. Inspect every consumer
before changing anything (the retrieval API, the QA API, the frontend, the tests).

## Safety floors that must not move

```
deliberately unanswerable   16/16 abstained, 0 false supported answers
counterfactual evidence     3/3 followed the altered evidence, 0 from memory
citation structural validity 100%
Selection scope             explicit paragraph ids; 0 provider calls; DS-QA-004 had
                            to fix it once already, and it is a P0 regression
```

# Decisions we need

**A.** Does RRF stay?

**B.** If it does, is `k = 60` justified? The brief asks for an actual sweep before
any value is called empirical — and one thing we can report now is that **fusion is
implicated in exactly one of twelve misses**, so a sweep may well show it does not
matter. Say what evidence would justify changing it, and whether the sweep is worth
running at all.

**C.** Should the original query's results be protected over rewritten ones?

**D.** Should rewrite variants have equal influence or a bounded lower one? Note the
count asymmetry: a question can produce one raw variant and four rewrite variants,
so "treat every list equally" is not neutral — it gives the rewrite family four
times the vote. Is that a real bias here, and how should it be measured?

**E.** Should block type affect ranking? DS-QA-001 measured that excluding references
changed nothing, and DS-QA-004 measured the section-title weight as unmeasurable.
Neither is a reason to add a block-type weight, only a reason not to assume one.

**F.** Body prose versus captions for generic conceptual questions — and what
protects *"what does Figure 3 show?"* from an overbroad rule?

**G.** Is a diversity stage after ranking justified? At most one of twelve misses is
about competition for slots, so say whether it is worth building.

**H.** Neighbour paragraphs: should they consume top-K slots, or attach after primary
selection? They are appended after the direct hits today, and the benchmark counts
only direct hits — but they do occupy bundle slots, and the bundle is what the
answer model's budget is spent on. Measure before deciding.

**I.** `EvidenceItem.score` — one generic value or explicit semantics? Propose the
minimal shape, and say what happens to the existing field and its consumers.

**J.** What frozen improvement gate makes this task successful? Given the
measurements above, a gate expressed as "+10 points of Hit@5" may be unreachable
when only seven questions are in scope; say what a *meaningful* gate looks like, and
what result would instead justify stopping.

Also worth your judgement: **is this task worth doing at all?** Coverage fixes four
of thirty-three questions. If your reading is that the remaining ranking headroom
does not justify new complexity, say so and freeze the smaller thing — the brief's
own product decision D is "current system good enough".

# Constraints

* **0 additional provider calls.** Ranking is local.
* No embeddings, no vector store, no cross-encoder, no LLM reranker, no new rewrite
  or analysis calls.
* Scope stays authoritative: rank *inside* scope-constrained candidates, never
  retrieve globally and filter afterwards.
* Canonical identity stays `paragraph_id` / block id — never text, because a paper
  repeats its own sentences.
* Do not weaken grounding to make a number move. Correct abstention beats
  irrelevant evidence.
* Do not tune on the held-out set. PPO has been read repeatedly now and is no longer
  untouched; if the final decision needs a genuinely held-out evaluation, say what
  it should be and we will build it before measuring.
* Deterministic: no new random or model-dependent ordering, and a stable tie-break.

Cover at least: baseline reproduction; NOT_RETRIEVED versus LOW_RANK; the
ranking-only boundary; the raw / expansion / rewrite paths; RRF behaviour and its
parameters; path weighting; exact-term queries; paraphrase; cross-language;
entity-type; duplicate and near-duplicate candidates; canonical deduplication;
body, captions, headings, references; section metadata; neighbour expansion and the
evidence window; score semantics and ranking diagnostics; all four scopes; document
isolation; citation identity; answerability and unanswerable regressions; a
held-out benchmark; no paper-specific hardcoding; latency; backend and frontend
regression; and a real-browser check.

Answer A–J explicitly. Where you disagree with this brief, say so and say why.

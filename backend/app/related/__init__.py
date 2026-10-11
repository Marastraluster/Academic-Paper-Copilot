"""Related papers — the first feature that reaches the network on its own.

Everything else in this backend talks only to endpoints the reader configured
for a request they made. This does too, but its whole point is to ask an outside
index about the paper, so it is **off until a `search` profile exists**: the
profile is the opt-in, and its absence is answered with a clear
`SEARCH_NOT_CONFIGURED` rather than a silent request.

What is sent: the paper's DOI or arXiv id when the paper prints one, otherwise
its title; free-text queries the reader types. Never the paper's text, never the
reader's notes.

Modules:

* :mod:`app.related.sources` — OpenAlex and Semantic Scholar behind one shape.
* :mod:`app.related.service` — identify the paper, gather references, citing
  work and similar work, and tie references back to where the paper cites them.
* :mod:`app.related.explain` — one model call that says, per candidate, how it
  relates to this paper, from the two abstracts only.
"""

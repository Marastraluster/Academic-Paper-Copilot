"""MinerU — document parsing as a service this backend calls, never imports.

MinerU turns a PDF into structured content: headings with levels, paragraphs in
reading order with inline LaTeX, display formulas as LaTeX, tables as HTML and
figures as image files. That is exactly what the reflowed bilingual reading
needs, and what the in-house layout model could only approximate with crops.

It is reached over HTTP and **never imported**. MinerU pins its own `openai`,
`torch` and model stack, which do not fit beside this backend's; and the same
"v1" API is served by a local `mineru-api`, by a lab server, and by mineru.net,
so one client covers every deployment the reader can configure — the
deployment is a URL and an optional key in a `parser` profile.

Modules:

* :mod:`app.mineru.client` — upload, submit, poll, download.
* :mod:`app.mineru.convert` — MinerU's middle JSON → :class:`DocumentIR`.
* :mod:`app.mineru.jobs` — parsing as a background job with observable state.
"""

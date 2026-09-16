# Evidence — DS-BE-FIX-001 Log record loss on a non-UTF-8 console

- **Date:** 2026-09-16
- **Agent:** DeepSeek (Claude Code CLI)
- **Type:** Defect fix (not a feature task)
- **Verdict:** **FIXED and verified by controlled before/after**

## Why there is no Gemini-authored criteria document

The workflow authors acceptance criteria before implementation for **feature** work, where
"what good looks like" is a judgement call. This is a defect with an objective reproduction:

> A log record containing a character the console cannot encode must still reach the stream.

That criterion is not a matter of opinion, and it was written down (in the reproduction below)
before the fix. Recorded here rather than manufacturing a criteria document to satisfy a
process step whose purpose does not apply.

## The defect

Windows consoles commonly use a legacy code page — **GBK** on this machine. `logging` writes
through `sys.stdout` with `errors="strict"`, so an unencodable character raises
`UnicodeEncodeError`. `logging` catches it, prints a `--- Logging error ---` traceback, and
**drops the entire record**.

Reproduction, with stdout redirected (a real console uses a different, Unicode-capable path):

```
$ python -c "import logging,sys; logging.basicConfig(handlers=[logging.StreamHandler(sys.stdout)]);
             logging.getLogger('t').info('sk-••••ab12')" > out.txt
--- Logging error ---
UnicodeEncodeError: 'gbk' codec can't encode character '•' ...
```

**Why it matters.** `docs/ACCEPTANCE DS-BE-005` AC-09 mandates `•` (U+2022) for masking API
keys. Any record carrying a masked key — or any other character GBK cannot represent — was
being silently discarded on this platform.

**Why the existing tests missed it.** `test_secret_never_reaches_the_log_stream` asserts the
secret is *absent*. A record that vanished satisfies that trivially. **A test that can only
check for absence cannot detect lost output** — so the fix comes with a test that asserts
*arrival*.

## The fix

`backend/app/logging.py`: `configure_logging` now routes through `_encoding_safe_stream`,
which reconfigures the stream with `errors="backslashreplace"`. An unencodable character
degrades to a `\uXXXX` escape; the record survives. Streams that cannot be reconfigured are
returned untouched.

One helper, one call site, no behaviour change on a UTF-8 console.

## Verification — controlled before/after

Same input, same redirection; only the handler differs.

```
WITH the fix:
  exit=0
  {"timestamp": "...", "level": "INFO", "logger": "probe", "message": "display value",
   "masked_display": "sk-••••ab12", "note": "• bullet"}

WITHOUT the fix (raw StreamHandler):
  exit=0
  logging-error blocks: 1        <- the record was lost
```

This is what makes the change verifiable rather than merely plausible: the failure is
reproduced without the fix and absent with it.

## Tests

```
$ cd backend && .venv/Scripts/python -m pytest
    → 379 passed, 1 warning
      (377 before + 2 new)
```

| Test | Asserts |
|---|---|
| `test_unencodable_characters_do_not_destroy_the_log_record` | Subprocess with redirected stdout: no `Logging error`, the record **arrives**, value escaped not dropped |
| `test_encoding_safe_stream_leaves_normal_streams_alone` | Ordinary streams pass through untouched; non-reconfigurable objects are handled |

## Known Limitations

- **Only the logging stream is hardened.** `print()` to a redirected GBK console would still
  raise. The application logs rather than prints, so this is not currently reachable — but it
  is not a general fix for console encoding.
- **`\uXXXX` escapes appear in logs** on such consoles instead of the literal character. That
  is a deliberate trade: a readable-in-a-JSON-parser escaped value beats a lost record.
- **Verified on this machine's GBK console only.** A UTF-8 console never exhibited the defect,
  so the fix is a no-op there — which the second test confirms.

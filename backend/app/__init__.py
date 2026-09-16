"""Academic PDF Copilot — local backend.

AC-01: importing this package must have **no side effects**. No database file is
created, nothing is logged, and no network call is made at import time. All
startup work happens in the application lifespan (see ``app.main``).

This is deliberate: the upstream PDF library this project builds on runs its
database initialisation at import, which makes it impossible to import in a
read-only context (docs/REPO_AUDIT.md §9). We do not repeat that mistake.
"""

__version__ = "0.1.0"

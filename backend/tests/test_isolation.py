"""AC-01, AC-25, AC-26 — the backend must not touch anything it does not own.

These are the guard-rails for the two worst failure modes of a "foundation"
task: creating files as a side effect of importing, and running tests against the
developer's real data.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import BACKEND_DIR, default_data_dir

#: Directories owned by the upstream PDF library. We must never touch them
#: (FC-06). Our Phase 0 audit found it stores config in plaintext and a cache
#: here; that is exactly why this backend does not reuse it.
UPSTREAM_PATHS = [
    Path.home() / ".cache" / "pdf2zh",
    Path.home() / ".config" / "PDFMathTranslate",
]


def snapshot(path: Path) -> tuple[bool, float]:
    """Existence + mtime, used to prove a path was left alone."""
    if not path.exists():
        return (False, 0.0)
    return (True, path.stat().st_mtime)


# --- AC-01: import must be inert --------------------------------------------


def test_importing_the_app_creates_no_database(tmp_path: Path) -> None:
    """AC-01 — construction is side-effect free; the lifespan does the work."""
    target = tmp_path / "must-not-appear.sqlite3"
    env = {**os.environ, "DATABASE_PATH": str(target)}

    result = subprocess.run(
        [sys.executable, "-c", "import app.main; print('imported')"],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert result.returncode == 0, result.stderr
    assert "imported" in result.stdout
    assert not target.exists(), "importing app.main created a database file"


def test_importing_the_app_emits_no_log_output() -> None:
    """AC-01 — nothing is logged at import time either."""
    result = subprocess.run(
        [sys.executable, "-c", "import app.main"],
        cwd=BACKEND_DIR,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "", f"import wrote to stdout: {result.stdout!r}"
    assert "Backend started" not in result.stderr


def test_import_does_not_create_the_default_user_database() -> None:
    """AC-01 + AC-26 — the per-user default location stays untouched."""
    default_db = default_data_dir() / "db.sqlite3"
    before = snapshot(default_db)

    subprocess.run(
        [sys.executable, "-c", "import app.main"],
        cwd=BACKEND_DIR,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert snapshot(default_db) == before


# --- AC-25 / FC-06: upstream directories stay untouched ---------------------


@pytest.mark.parametrize("upstream", UPSTREAM_PATHS, ids=lambda p: p.name)
def test_upstream_directories_are_not_touched(upstream: Path, client: TestClient) -> None:
    """AC-25 — a full startup + request cycle must not disturb upstream state."""
    before = snapshot(upstream)

    client.get("/api/health")

    assert snapshot(upstream) == before, f"{upstream} was modified by the backend"


def test_source_does_not_reference_upstream_paths() -> None:
    """A grep-level guard, so the rule survives future edits.

    Narrowed by DS-PDF-001. The original guard forbade any mention of the upstream
    project anywhere in the backend, which was correct while nothing imported it.
    The PDF kernel now legitimately does (that is the entire point of
    ``app/pdfkernel``), so the *name* is permitted there — while the protection
    that actually matters is kept and strengthened: **nothing**, kernel included,
    may reference upstream's config or cache directories. Those hold a plaintext
    API-key config file and a shared model cache, and touching either is the
    failure mode this guard exists to prevent (DS-BE-001 FC-06).
    """
    app_root = BACKEND_DIR / "app"
    kernel = app_root / "pdfkernel"

    # Hardcoded locations of upstream's own state. These hold a plaintext
    # API-key config file and a shared model cache, so a literal reference in
    # *code* is a defect wherever it appears — kernel included.
    forbidden_paths = (".cache/pdf2zh", ".config/PDFMathTranslate")

    offenders: list[str] = []
    for source in app_root.rglob("*.py"):
        text = source.read_text(encoding="utf-8")
        where = source.relative_to(app_root)

        # Checked against code strings rather than raw text: the kernel's
        # docstring deliberately names the cache path in order to explain that
        # upstream owns it and we must not touch it. Comments and docstrings are
        # prose, not behaviour, so they are excluded — a guard that fires on
        # documentation teaches people to delete the documentation.
        for literal in _code_string_literals(source):
            for marker in forbidden_paths:
                if marker in literal:
                    offenders.append(f"{where}: hardcoded upstream path {marker!r}")

        # Outside the kernel, upstream should not be referenced at all.
        if not source.is_relative_to(kernel):
            for marker in ("pdf2zh", "PDFMathTranslate", "ConfigManager"):
                if marker in text:
                    offenders.append(f"{where}: references upstream outside pdfkernel")

    assert not offenders, f"upstream isolation violated: {offenders}"


def _code_string_literals(source: Path) -> list[str]:
    """String literals that are *executed*, excluding docstrings.

    Comments never appear in an AST, and a module/class/function docstring is
    identified by position — the first statement of a body.
    """
    import ast as _ast

    tree = _ast.parse(source.read_text(encoding="utf-8"), filename=str(source))

    docstrings: set[int] = set()
    for node in _ast.walk(tree):
        if isinstance(node, (_ast.Module, _ast.ClassDef, _ast.FunctionDef, _ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            first = body[0] if body else None
            if (
                isinstance(first, _ast.Expr)
                and isinstance(first.value, _ast.Constant)
                and isinstance(first.value.value, str)
            ):
                docstrings.add(id(first.value))

    return [
        node.value
        for node in _ast.walk(tree)
        if isinstance(node, _ast.Constant)
        and isinstance(node.value, str)
        and id(node) not in docstrings
    ]


def test_only_the_kernel_imports_upstream() -> None:
    """DS-PDF-001 AC-01 — one package, enforced structurally rather than by grep.

    Parses each module and looks at its actual import statements, so a mention in
    a docstring or comment cannot trip it and a real import cannot hide.
    """
    import ast

    app_root = BACKEND_DIR / "app"
    kernel = app_root / "pdfkernel"

    offenders: list[str] = []
    for source in app_root.rglob("*.py"):
        if source.is_relative_to(kernel):
            continue
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        for node in ast.walk(tree):
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = [node.module]
            if any(name.split(".")[0] in {"pdf2zh", "babeldoc"} for name in names):
                offenders.append(f"{source.relative_to(app_root)}: {names}")

    assert not offenders, f"upstream imported outside app/pdfkernel: {offenders}"


# --- AC-26 / AC-38.10: the suite does not use the real database -------------


def test_settings_fixture_points_into_tmp(settings, tmp_path: Path) -> None:
    """AC-26 — the isolation mechanism itself, asserted directly."""
    assert settings.database_path.is_relative_to(tmp_path)
    assert settings.database_path != default_data_dir() / "db.sqlite3"


def test_running_the_app_does_not_touch_the_default_database(app, settings, tmp_path: Path) -> None:
    """AC-38.10 — a full startup writes only inside tmp_path."""
    from fastapi.testclient import TestClient

    default_db = default_data_dir() / "db.sqlite3"
    before = snapshot(default_db)

    with TestClient(app) as test_client:
        assert settings.database_path.exists()
        assert settings.database_path.is_relative_to(tmp_path)
        test_client.get("/api/health")

    assert snapshot(default_db) == before, "the real user database was touched"


def test_test_database_contains_only_expected_tables(client: TestClient, settings) -> None:
    """AC-06 — also proves the fixture's database is the one that got created.

    ``profiles`` added by DS-BE-005; the assertion stays pinned to an exact set.
    """
    import sqlite3

    connection = sqlite3.connect(str(settings.database_path))
    try:
        names = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    finally:
        connection.close()

    assert sorted(names) == ["documents", "profiles", "schema_version", "translation_tasks"]


# --- AC-11: dependency manifest is explicit and minimal ---------------------


def test_dependency_manifest_declares_expected_packages() -> None:
    manifest = (BACKEND_DIR / "pyproject.toml").read_text(encoding="utf-8")
    text = manifest.lower()

    # `openai` joined this list in DS-BE-002 (its AC-31), where it became a
    # dependency the backend is actually programmed against rather than one
    # inherited transitively.
    for package in ("fastapi", "uvicorn", "pytest", "httpx", "keyring", "openai"):
        assert package in text, f"{package} missing from the dependency manifest"

    # Speculative heavyweights that must not appear this early (AC-11).
    # `openai` was removed from this guard by DS-BE-002/AC-31, which requires it
    # to be declared. The rest still stand: none of these belong to a backend
    # phase that has not started.
    for forbidden in ("torch", "onnxruntime", "opencv", "chromadb", "anthropic", "pdf2zh"):
        assert forbidden not in text, f"{forbidden} should not be a backend dependency yet"


def test_env_example_documents_the_supported_variables() -> None:
    """AC-10."""
    example = (BACKEND_DIR / ".env.example").read_text(encoding="utf-8")
    uppercased = example.upper()

    for variable in ("HOST", "PORT", "DATABASE_PATH", "LOG_LEVEL", "CORS_ORIGINS"):
        assert variable in uppercased, f"{variable} undocumented in .env.example"

    # It must contain no real secret and no real user path.
    assert "sk-" not in example
    assert str(Path.home()) not in example


def test_env_example_is_not_a_live_env_file() -> None:
    """The template documents; the real .env is for the developer and is ignored."""
    assert (BACKEND_DIR / ".env.example").exists()
    assert not (BACKEND_DIR / ".env").exists() or (BACKEND_DIR / ".env").name != ".env.example"

    gitignore = (BACKEND_DIR.parent / ".gitignore").read_text(encoding="utf-8")
    assert ".env" in gitignore


def test_readme_documents_a_single_startup_command() -> None:
    """AC-02."""
    readme = (BACKEND_DIR / "README.md").read_text(encoding="utf-8")

    assert "uvicorn app.main:app" in readme
    assert "127.0.0.1" in readme


def test_no_python_313_syntax_is_used() -> None:
    """AC-27 — the backend targets 3.12."""
    if sys.version_info[:2] != (3, 12):
        pytest.skip(f"interpreted under {sys.version_info[:2]}, not 3.12")

    for source in (BACKEND_DIR / "app").rglob("*.py"):
        compile(source.read_text(encoding="utf-8"), str(source), "exec")

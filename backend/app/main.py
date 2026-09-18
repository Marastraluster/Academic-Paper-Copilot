"""FastAPI application factory (AC-01, AC-02, AC-03, AC-08, AC-15, AC-36).

Importing this module builds the ASGI app but performs **no** startup work: no
database file is created, nothing is logged, and no socket is opened. All of that
happens in the lifespan handler when the server actually starts.

The documented way to run it (see backend/README.md)::

    .venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-server-header
"""

from __future__ import annotations

import time
from contextlib import asynccontextmanager
from typing import AsyncIterator
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api import annotations, documents, health, profiles
from app.api.documents import register_document_error_handlers
from app.api.profiles import register_profile_error_handlers
from app.config import Settings
from app.db import bootstrap_database
from app.errors import register_exception_handlers
from app.documents.store import DocumentStore
from app.documents.tasks import TaskRunner
from app.storage.profiles import ProfileStore
from app.logging import (
    REQUEST_ID_HEADER,
    configure_logging,
    get_logger,
    request_id_var,
)

logger = get_logger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the ASGI application.

    ``settings`` is injectable so tests can point ``DATABASE_PATH`` at a
    temporary directory before the app — and therefore the lifespan — runs
    (AC-26).
    """
    resolved = settings if settings is not None else Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        configure_logging(resolved.log_level)

        connection = bootstrap_database(resolved.database_path)
        app.state.db = connection
        app.state.settings = resolved
        # One store, built once. Endpoints read it from app.state rather than
        # opening their own connection per request.
        app.state.profile_store = ProfileStore(connection)
        # Annotations share the application database — one store, one connection,
        # the same shape as the profile store above.
        app.state.annotation_connection = connection

        document_store = DocumentStore(connection, resolved.documents_dir)
        task_runner = TaskRunner(document_store, app.state.profile_store)
        app.state.document_store = document_store
        app.state.task_runner = task_runner

        # A translation runs in memory, so a restart orphans whatever was in
        # flight. Mark those as failed rather than leaving them looking active.
        interrupted = document_store.reconcile_interrupted_tasks()
        if interrupted:
            logger.info(
                "Marked interrupted translations as failed",
                extra={"count": interrupted},
            )

        logger.info(
            "Backend started",
            extra={
                "app": "Academic PDF Copilot",
                "version": __version__,
                # The address the documented start command binds to (AC-36).
                "address": f"http://{resolved.host}:{resolved.port}",
                "database_path": str(resolved.database_path),
            },
        )

        try:
            yield
        finally:
            # Ask any in-flight translation to stop before the connection closes.
            await task_runner.shutdown()
            connection.close()
            logger.info("Backend stopped")

    app = FastAPI(
        title="Academic PDF Copilot",
        version=__version__,
        lifespan=lifespan,
        # Interactive docs are a local development convenience only (AC-37).
        docs_url="/docs" if resolved.debug else None,
        redoc_url=None,
    )

    register_exception_handlers(app)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved.cors_origin_list,  # never a wildcard (AC-31)
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", REQUEST_ID_HEADER],
        expose_headers=[REQUEST_ID_HEADER],
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        """Attach a request id and emit one structured access log per request."""
        incoming = request.headers.get(REQUEST_ID_HEADER)
        request_id = incoming or str(uuid4())
        token = request_id_var.set(request_id)
        # Also parked on the scope, because the 500 handler runs in
        # ServerErrorMiddleware — outside this middleware — and still needs to
        # echo the id (AC-15).
        request.state.request_id = request_id
        started = time.perf_counter()

        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)

        response.headers[REQUEST_ID_HEADER] = request_id
        logger.info(
            "request",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "status_code": response.status_code,
                "duration_ms": round((time.perf_counter() - started) * 1000, 2),
            },
        )
        return response

    register_profile_error_handlers(app)
    register_document_error_handlers(app)

    app.include_router(health.router, prefix="/api")
    app.include_router(profiles.router, prefix="/api")
    app.include_router(documents.router, prefix="/api")
    app.include_router(annotations.router, prefix="/api")
    return app


# Module-level app for `uvicorn app.main:app`. Constructing it is side-effect free.
app = create_app()

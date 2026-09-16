"""Normalised error envelope and exception handlers (AC-19 … AC-23).

Every error leaving this API has the same shape::

    {"error": {"code": "...", "message": "...", "detail": {}}}

FastAPI's defaults are deliberately overridden. Out of the box it returns
``{"detail": "Not Found"}`` for 404s and raw tracebacks for unhandled
exceptions; neither matches the contract in docs/API_CONTRACT.md §0, and the
latter leaks internals.

The client-facing message for a 500 is a fixed sentence. The real exception is
logged locally where the developer can see it, and never travels to the client.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.logging import REQUEST_ID_HEADER, get_logger, request_id_var

logger = get_logger(__name__)

# Stable, machine-readable codes. Never reword an existing code — clients match
# on these strings.
NOT_FOUND = "NOT_FOUND"
METHOD_NOT_ALLOWED = "METHOD_NOT_ALLOWED"
VALIDATION_ERROR = "VALIDATION_ERROR"
BAD_REQUEST = "BAD_REQUEST"
INTERNAL_ERROR = "INTERNAL_ERROR"
HTTP_ERROR = "HTTP_ERROR"

#: Fixed text returned for any unhandled server error. Say nothing about what
#: actually went wrong (AC-23).
INTERNAL_ERROR_MESSAGE = "An internal error occurred."

_STATUS_TO_CODE = {
    400: BAD_REQUEST,
    404: NOT_FOUND,
    405: METHOD_NOT_ALLOWED,
    422: VALIDATION_ERROR,
}


def error_payload(code: str, message: str, detail: Any | None = None) -> dict[str, Any]:
    """Build the error envelope.

    ``detail`` defaults to ``{}`` so the shape is uniform whether or not the
    caller has anything extra to say.
    """
    return {"error": {"code": code, "message": message, "detail": detail if detail is not None else {}}}


def error_response(
    status_code: int,
    code: str,
    message: str,
    detail: Any | None = None,
) -> JSONResponse:
    return JSONResponse(status_code=status_code, content=error_payload(code, message, detail))


async def http_exception_handler(
    request: Request, exc: StarletteHTTPException
) -> JSONResponse:
    """404, 405 and any explicitly raised HTTPException."""
    code = _STATUS_TO_CODE.get(exc.status_code, HTTP_ERROR)
    # Starlette puts its own wording in `detail`; that is safe to surface.
    message = str(exc.detail) if exc.detail else "Request failed."
    return error_response(exc.status_code, code, message)


async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """Malformed query/body parameters (422)."""
    return error_response(
        422,
        VALIDATION_ERROR,
        "Request parameters failed validation.",
        {"errors": _jsonable_validation_errors(exc)},
    )


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Last line of defence: log the truth, tell the client nothing (AC-23)."""
    logger.exception(
        "Unhandled exception while processing request",
        extra={"method": request.method, "path": request.url.path},
    )
    response = error_response(500, INTERNAL_ERROR, INTERNAL_ERROR_MESSAGE)

    # This handler is invoked by ServerErrorMiddleware, which sits *outside* the
    # request middleware — so the correlation header must be re-attached here or
    # a 500 would be the one response without it (AC-15).
    request_id = getattr(request.state, "request_id", None) or request_id_var.get()
    if request_id:
        response.headers[REQUEST_ID_HEADER] = request_id

    return response


def _jsonable_validation_errors(exc: RequestValidationError) -> list[dict[str, Any]]:
    """Reduce pydantic errors to plain data safe to serialise."""
    errors: list[dict[str, Any]] = []
    for error in exc.errors():
        errors.append(
            {
                "location": [str(part) for part in error.get("loc", ())],
                "message": str(error.get("msg", "")),
                "type": str(error.get("type", "")),
            }
        )
    return errors


def register_exception_handlers(app: FastAPI) -> None:
    """Attach every handler. Order here does not matter; specificity does."""
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)

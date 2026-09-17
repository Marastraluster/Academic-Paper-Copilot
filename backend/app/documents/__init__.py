"""Document management and translation tasks.

Sits between the HTTP layer and the PDF kernel: it owns where files live, what
state a translation is in, and which failure a client is told about — so neither
the routes nor the kernel has to know about the other.

The kernel itself is untouched by this package; it is consumed through its public
API only.
"""

from app.documents.tasks import TaskRunner
from app.documents.store import (
    DocumentNotFoundError,
    DocumentRecord,
    DocumentStore,
    DocumentStoreError,
    TaskAlreadyTerminalError,
    TaskNotFoundError,
    TaskRecord,
)

__all__ = [
    "DocumentStore",
    "DocumentRecord",
    "DocumentStoreError",
    "DocumentNotFoundError",
    "TaskRecord",
    "TaskNotFoundError",
    "TaskAlreadyTerminalError",
    "TaskRunner",
]

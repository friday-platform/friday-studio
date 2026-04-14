"""Corpus appender — non-blocking append of reflection entries to the daemon memory API.

Calls POST /api/memory/{workspace_id}/narrative/reflections with a NarrativeEntry
payload. Uses ctx.http.fetch() from the Friday agent SDK. Failures are logged
but never raised — observation durability is best-effort.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Protocol

from reflection_schema import ReflectionEntry

log = logging.getLogger("reflector.corpus_appender")

CORPUS_NAME = "reflections"
CORPUS_KIND = "narrative"


class HttpClient(Protocol):
    def fetch(self, url: str, *, method: str, body: str | None = None,
              headers: dict[str, str] | None = None, timeout_ms: int = 10000) -> Any: ...


class CorpusAppender:
    """Appends ReflectionEntry payloads to a workspace's 'reflections' corpus."""

    def __init__(self, platform_url: str, http: HttpClient) -> None:
        self._platform_url = platform_url.rstrip("/")
        self._http = http

    def append_reflection(self, workspace_id: str, entry: ReflectionEntry) -> bool:
        """Append a reflection to the narrative corpus. Returns True on success.

        Non-blocking: catches all exceptions and returns False on failure.
        """
        url = f"{self._platform_url}/api/memory/{workspace_id}/narrative/{CORPUS_NAME}"
        payload = entry.to_narrative_entry()

        try:
            resp = self._http.fetch(
                url,
                method="POST",
                body=json.dumps(payload),
                headers={"Content-Type": "application/json"},
                timeout_ms=10000,
            )
            if resp.status != 200:
                log.warning(
                    "corpus append failed: HTTP %d for %s/%s",
                    resp.status, workspace_id, CORPUS_NAME,
                )
                return False
            return True
        except Exception as exc:
            log.warning("corpus append failed: %s", exc)
            return False

#!/usr/bin/env python3
"""
prepare-commit-msg hook: appends a Langfuse-Trace trailer to commit messages.
Installed by langfuse-cli.
"""

import os
import sys
from pathlib import Path

try:
    from langfuse_utils import (
        LAST_TRACE_FILE,
        read_recent_trace,
        resolve_repo_root,
        tracing_enabled,
    )
except ImportError:
    LAST_TRACE_FILE = Path.home() / ".claude" / "state" / "langfuse_last_trace.json"
    import json
    from datetime import datetime, timezone

    def tracing_enabled() -> bool:
        return os.environ.get("TRACE_TO_LANGFUSE", "").lower() == "true"

    def read_recent_trace(
        path: Path, max_age_hours: float, expected_session_id: str | None = None
    ) -> dict | None:
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
        if not isinstance(data, dict):
            return None
        trace_url = data.get("trace_url")
        trace_id = data.get("trace_id")
        if not isinstance(trace_url, str) or not trace_url:
            return None
        if not isinstance(trace_id, str) or not trace_id:
            return None
        if expected_session_id and data.get("session_id") != expected_session_id:
            return None
        updated_at = data.get("updated_at")
        if isinstance(updated_at, str):
            try:
                ts = datetime.fromisoformat(updated_at)
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                age_hours = (datetime.now(timezone.utc) - ts).total_seconds() / 3600
                if age_hours > max_age_hours:
                    return None
            except Exception:
                return None
        else:
            return None
        return data

    def resolve_repo_root(search_path: Path) -> Path | None:
        _ = search_path
        return None


MAX_AGE_HOURS = 4
SESSION_TRAILER_KEY = "Langfuse-Session"


def _append_trailers(content: str, trailers: list[str]) -> str:
    """Append one or more trailers to a commit message, preserving existing trailer blocks."""
    lines = content.rstrip("\n").split("\n")

    has_existing_trailers = False
    for line in reversed(lines):
        stripped = line.strip()
        if not stripped:
            break
        if ": " in stripped and not stripped.startswith("#"):
            has_existing_trailers = True
            break
        else:
            break

    joined = "\n".join(trailers)
    if has_existing_trailers:
        return "\n".join(lines) + "\n" + joined + "\n"
    return "\n".join(lines) + "\n\n" + joined + "\n"


def main() -> int:
    try:
        if not tracing_enabled():
            return 0

        if len(sys.argv) < 2:
            return 0

        msg_file = sys.argv[1]
        commit_source = sys.argv[2] if len(sys.argv) > 2 else ""

        if commit_source in ("merge", "squash"):
            return 0

        # Prefer the global last-trace file (updated eagerly by the PreToolUse
        # session-init hook for the *current* session) over the per-repo
        # current-session file (only updated by the Stop hook, which runs
        # *after* the commit finishes).
        data = read_recent_trace(LAST_TRACE_FILE, MAX_AGE_HOURS)
        if not data:
            repo_root = resolve_repo_root(Path.cwd()) or Path.cwd()
            local_trace_path = repo_root / ".langfuse" / "current-session.json"
            data = read_recent_trace(local_trace_path, MAX_AGE_HOURS)
        if not data:
            return 0

        session_url = data.get("session_url")
        if not isinstance(session_url, str) or not session_url:
            return 0

        try:
            content = Path(msg_file).read_text(encoding="utf-8")
        except Exception:
            return 0

        if f"{SESSION_TRAILER_KEY}:" in content:
            return 0

        result = _append_trailers(content, [f"{SESSION_TRAILER_KEY}: {session_url}"])
        Path(msg_file).write_text(result, encoding="utf-8")
        return 0

    except Exception:
        return 0


if __name__ == "__main__":
    sys.exit(main())

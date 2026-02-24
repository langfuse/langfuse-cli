#!/usr/bin/env python3
"""
prepare-commit-msg hook: appends a Langfuse-Trace trailer to commit messages.
Installed by langfuse-cli.
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    from langfuse_utils import LAST_TRACE_FILE, tracing_enabled
except ImportError:
    LAST_TRACE_FILE = Path.home() / ".claude" / "state" / "langfuse_last_trace.json"

    def tracing_enabled() -> bool:
        return os.environ.get("TRACE_TO_LANGFUSE", "").lower() == "true"


MAX_AGE_HOURS = 4
TRAILER_KEY = "Langfuse-Trace"


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

        if not LAST_TRACE_FILE.exists():
            return 0

        try:
            data = json.loads(LAST_TRACE_FILE.read_text(encoding="utf-8"))
        except Exception:
            return 0

        if not isinstance(data, dict):
            return 0

        trace_url = data.get("trace_url")
        if not isinstance(trace_url, str) or not trace_url:
            return 0

        updated_at = data.get("updated_at")
        if isinstance(updated_at, str):
            try:
                ts = datetime.fromisoformat(updated_at)
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                age_hours = (datetime.now(timezone.utc) - ts).total_seconds() / 3600
                if age_hours > MAX_AGE_HOURS:
                    return 0
            except Exception:
                pass

        try:
            content = Path(msg_file).read_text(encoding="utf-8")
        except Exception:
            return 0

        if f"{TRAILER_KEY}:" in content:
            return 0

        trailer = f"{TRAILER_KEY}: {trace_url}"
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

        if has_existing_trailers:
            result = "\n".join(lines) + "\n" + trailer + "\n"
        else:
            result = "\n".join(lines) + "\n\n" + trailer + "\n"

        Path(msg_file).write_text(result, encoding="utf-8")
        return 0

    except Exception:
        return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
PreToolUse hook: eagerly initializes the Langfuse trace ID for the current
Claude Code session so that prepare-commit-msg can reference it immediately.

On the first tool use of a session, this hook:
1. Generates a deterministic trace_id from the session_id
2. Writes it to ~/.claude/state/langfuse_last_trace.json

Subsequent invocations detect the matching session_id and exit immediately.
Installed by langfuse-cli.
"""

import hashlib
import os
import sys

try:
    from langfuse_utils import (
        debug,
        extract_session_id,
        get_langfuse_credentials,
        read_hook_payload,
        read_last_trace,
        save_last_trace,
        tracing_enabled,
    )
except ImportError:
    sys.exit(0)


def main() -> int:
    try:
        if not tracing_enabled():
            return 0

        payload = read_hook_payload()
        session_id = extract_session_id(payload)
        if not session_id:
            return 0

        existing = read_last_trace(expected_session_id=session_id)
        if existing:
            return 0

        creds = get_langfuse_credentials()
        if not creds:
            return 0

        # Generate a deterministic trace_id from the session_id.
        # Prefer the Langfuse SDK's create_trace_id (W3C-compatible 32-char hex)
        # with a fallback to SHA-256 for environments without the SDK or older versions.
        trace_id = None
        try:
            from langfuse import Langfuse

            lf = Langfuse(
                public_key=creds["public_key"],
                secret_key=creds["secret_key"],
                host=creds["host"],
            )
            trace_id = lf.create_trace_id(seed=session_id)
            lf.shutdown()
        except Exception:
            pass

        if not trace_id:
            trace_id = hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:32]

        save_last_trace(session_id, trace_id, creds["host"])
        debug(f"Initialized trace_id {trace_id} for session {session_id}")

        return 0

    except Exception:
        return 0


if __name__ == "__main__":
    sys.exit(main())

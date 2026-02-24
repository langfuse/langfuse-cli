#!/usr/bin/env python3
"""
Claude Code PostToolUse hook for git commit detection.

Fires after Bash tool use, checks if a git commit occurred, and records
metadata in a trace manifest. Installed by langfuse-cli.
"""

import json
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from langfuse_utils import (
        LAST_TRACE_FILE,
        atomic_write_json,
        build_github_commit_url,
        debug,
        extract_session_id,
        get_remote_url,
        read_hook_payload,
        read_last_trace,
        resolve_repo_root,
        run_git,
        tracing_enabled,
        write_trace_manifest,
    )
except ImportError:
    sys.exit(0)

GIT_COMMIT_RE = re.compile(r"^git(?:\s+-C\s+\S+)?\s+commit(?:\s|$)")


def _to_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if stripped and stripped.lstrip("-").isdigit():
            return int(stripped)
    return None


def _command_succeeded(payload: dict) -> bool | None:
    for key in (
        "exit_code",
        "exitCode",
        "status",
        "status_code",
        "tool_exit_code",
        "toolExitCode",
    ):
        if key not in payload:
            continue
        code = _to_int(payload.get(key))
        if code is not None:
            return code == 0

    for key in ("success", "ok"):
        if key in payload and isinstance(payload[key], bool):
            return payload[key]

    result = payload.get("tool_result")
    if isinstance(result, dict):
        return _command_succeeded(result)

    return None


def _extract_tool_name(payload: dict) -> str:
    value = payload.get("tool_name") or payload.get("toolName")
    return value if isinstance(value, str) else ""


def _extract_command(payload: dict) -> str:
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        tool_input = payload.get("toolInput")

    if isinstance(tool_input, dict):
        command = tool_input.get("command")
        if isinstance(command, str):
            return command

    command = payload.get("command")
    if isinstance(command, str):
        return command

    return ""


def _find_repo_root(payload: dict) -> Path:
    cwd = payload.get("cwd")
    if not isinstance(cwd, str) or not cwd.strip():
        cwd = os.getcwd()

    root = resolve_repo_root(Path(cwd))
    if root:
        return root
    return Path(cwd).expanduser().resolve()


def _head_changed_from_orig_head(repo_root: Path, head_sha: str) -> bool:
    orig_head = run_git(repo_root, ["rev-parse", "ORIG_HEAD"])
    if orig_head and orig_head == head_sha:
        return False
    return True


def _extract_host(trace_url: str | None) -> str | None:
    if not trace_url or "://" not in trace_url:
        return None
    before_trace = trace_url.split("/trace/")[0]
    return before_trace.rstrip("/") if before_trace else None


def _write_agent_trace_record(
    repo_root: Path,
    commit_sha: str,
    trace_url: str | None,
    session_id: str,
    remote_url: str | None,
) -> None:
    try:
        changed_files = run_git(repo_root, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit_sha])
        if not changed_files:
            return

        files = []
        conversation_entry: dict[str, Any] = {
            "contributor": {"type": "ai"},
            "ranges": [{"start_line": 1, "end_line": 1}],
        }
        if trace_url:
            conversation_entry["url"] = trace_url
        related: list[dict[str, str]] = []
        if trace_url:
            related.append({"type": "trace", "url": trace_url})
        if related:
            conversation_entry["related"] = related

        for fname in changed_files.strip().splitlines():
            fname = fname.strip()
            if not fname:
                continue
            fpath = repo_root / fname
            line_count = 1
            if fpath.is_file():
                try:
                    with open(fpath, "rb") as fh:
                        line_count = max(1, sum(1 for _ in fh))
                except Exception:
                    pass
            conv = dict(conversation_entry)
            conv["ranges"] = [{"start_line": 1, "end_line": line_count}]
            files.append({"path": fname, "conversations": [conv]})

        if not files:
            return

        record: dict[str, Any] = {
            "version": "0.1.0",
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "vcs": {"type": "git", "revision": commit_sha},
            "tool": {"name": "claude-code"},
            "files": files,
            "metadata": {"sessionId": session_id},
        }

        traces_dir = repo_root / ".langfuse" / "traces"
        record_path = traces_dir / f"agent-trace-{commit_sha[:12]}.json"
        atomic_write_json(record_path, record)
        debug(f"Wrote Agent Trace record to {record_path}")
    except Exception as exc:
        debug(f"_write_agent_trace_record failed: {exc}")


def main() -> int:
    try:
        if not tracing_enabled():
            return 0

        payload = read_hook_payload()
        if _extract_tool_name(payload) != "Bash":
            return 0

        command = _extract_command(payload).strip()
        if not command or not GIT_COMMIT_RE.match(command):
            return 0

        command_success = _command_succeeded(payload)
        if command_success is False:
            return 0

        creds_ok = (
            os.getenv("LANGFUSE_PUBLIC_KEY")
            and os.getenv("LANGFUSE_SECRET_KEY")
        )
        if not creds_ok:
            return 0

        host = (
            os.getenv("LANGFUSE_BASE_URL")
            or os.getenv("LANGFUSE_HOST")
            or "https://cloud.langfuse.com"
        ).rstrip("/")

        repo_root = _find_repo_root(payload)

        session_id = extract_session_id(payload)

        # Read last-trace with session validation to avoid cross-session confusion
        session_data = read_last_trace(expected_session_id=session_id)

        # Fallback: try per-repo session file (legacy)
        if not session_data:
            legacy_session_path = repo_root / ".langfuse" / "current-session.json"
            if legacy_session_path.exists():
                try:
                    data = json.loads(legacy_session_path.read_text(encoding="utf-8"))
                    if isinstance(data, dict) and data.get("trace_id"):
                        if not session_id or data.get("session_id") == session_id:
                            session_data = data
                except Exception:
                    pass

        if not session_data:
            return 0

        session_id = session_data.get("session_id", session_id or "")
        trace_id = session_data.get("trace_id")
        trace_url = session_data.get("trace_url")

        if not isinstance(session_id, str) or not session_id:
            return 0
        if not isinstance(trace_id, str) or not trace_id:
            return 0
        if not isinstance(trace_url, str) or not trace_url:
            trace_url = f"{host}/trace/{trace_id}"

        commit_sha = run_git(repo_root, ["rev-parse", "HEAD"])
        if not commit_sha:
            return 0

        if command_success is None and not _head_changed_from_orig_head(repo_root, commit_sha):
            return 0

        branch = run_git(repo_root, ["rev-parse", "--abbrev-ref", "HEAD"]) or "unknown"
        commit_message = run_git(repo_root, ["log", "-1", "--pretty=%s"]) or ""

        remote_url = get_remote_url(repo_root)
        commit_url = build_github_commit_url(remote_url, commit_sha)

        metadata = {
            "commit_sha": commit_sha,
            "commit_url": commit_url,
            "commit_message": commit_message,
            "branch": branch,
            "remote_url": remote_url,
            "session_id": session_id,
            "source": "claude-code",
        }

        try:
            from langfuse import Langfuse, propagate_attributes

            langfuse = Langfuse(
                public_key=os.getenv("LANGFUSE_PUBLIC_KEY"),
                secret_key=os.getenv("LANGFUSE_SECRET_KEY"),
                host=host,
            )

            propagated_meta: dict[str, str] = {}
            if isinstance(commit_url, str) and commit_url and len(commit_url) <= 200:
                propagated_meta["githubCommitUrl"] = commit_url

            observation_kwargs: dict[str, Any] = {
                "as_type": "span",
                "name": "git-commit",
                "trace_context": {"trace_id": trace_id},
                "metadata": metadata,
            }

            with propagate_attributes(
                session_id=session_id,
                metadata=propagated_meta if propagated_meta else {},
                tags=["claude-code"],
            ):
                try:
                    with langfuse.start_as_current_observation(**observation_kwargs):
                        pass
                except TypeError as exc:
                    if "trace_context" in str(exc):
                        observation_kwargs.pop("trace_context", None)
                        with langfuse.start_as_current_observation(**observation_kwargs):
                            pass
                    else:
                        raise

            langfuse.flush()
            langfuse.shutdown()
        except Exception as exc:
            debug(str(exc))

        git_metadata = {
            "git_commit_sha": commit_sha,
            "git_commit_url": commit_url,
            "git_remote_url": remote_url,
        }
        write_trace_manifest(repo_root, session_id, trace_id, _extract_host(trace_url) or host, git_metadata)

        _write_agent_trace_record(
            repo_root, commit_sha, trace_url, session_id, remote_url,
        )

        return 0
    except Exception as exc:
        debug(str(exc))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())

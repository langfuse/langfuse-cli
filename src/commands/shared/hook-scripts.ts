export const STOP_HOOK_SCRIPT = String.raw`#!/usr/bin/env python3
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def _debug(message: str) -> None:
    if os.getenv("LANGFUSE_CLAUDE_HOOK_DEBUG", "").lower() == "true":
        print(f"[langfuse_hook] {message}", file=sys.stderr)


def _read_payload() -> dict:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _get_nested(payload: dict, *keys: str):
    for key in keys:
        if key in payload and payload[key] is not None:
            return payload[key]
    return None


def _extract_session_id(payload: dict) -> str | None:
    value = _get_nested(payload, "sessionId", "session_id")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _extract_transcript_path(payload: dict) -> str | None:
    value = _get_nested(payload, "transcriptPath", "transcript_path")
    if isinstance(value, str) and value.strip():
        return value.strip()

    context = payload.get("context")
    if isinstance(context, dict):
        nested = _get_nested(context, "transcriptPath", "transcript_path")
        if isinstance(nested, str) and nested.strip():
            return nested.strip()

    return None


def _find_repo_root(payload: dict, transcript_path: str | None) -> Path:
    candidates: list[Path] = []

    for key in ("cwd", "workingDirectory", "projectPath", "repoRoot"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            candidates.append(Path(value.strip()))

    if transcript_path:
        candidates.append(Path(transcript_path).expanduser().resolve().parent)

    candidates.append(Path.cwd())

    for candidate in candidates:
        try:
            resolved = candidate.expanduser().resolve()
        except Exception:
            continue

        for parent in [resolved, *resolved.parents]:
            if (parent / ".git").exists():
                return parent

    try:
        return Path.cwd().resolve()
    except Exception:
        return Path.cwd()


def _load_transcript_events(transcript_path: str | None) -> list[dict]:
    if not transcript_path:
        return []

    path = Path(transcript_path).expanduser()
    if not path.exists():
        return []

    events: list[dict] = []

    try:
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                try:
                    item = json.loads(line)
                except Exception:
                    continue

                if isinstance(item, dict):
                    events.append(item)
    except Exception:
        return []

    return events


def _content_to_text(content) -> str:
    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
                continue
            if isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join([part for part in parts if part])

    return ""


def _extract_turn(events: list[dict]) -> tuple[int, str]:
    assistant_messages: list[str] = []

    for event in events:
        role = event.get("role")
        if not isinstance(role, str):
            message = event.get("message")
            if isinstance(message, dict):
                role = message.get("role")

        if role not in {"assistant", "model"}:
            continue

        text = _content_to_text(event.get("content"))
        if not text:
            message = event.get("message")
            if isinstance(message, dict):
                text = _content_to_text(message.get("content"))

        if text.strip():
            assistant_messages.append(text.strip())

    if not assistant_messages:
        return (1, "")

    return (len(assistant_messages), assistant_messages[-1])


def _load_existing_session(session_path: Path, session_id: str | None) -> dict:
    if not session_path.exists():
        return {}

    try:
        data = json.loads(session_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {}

        if session_id and isinstance(data.get("session_id"), str):
            if data["session_id"] != session_id:
                return {}

        return data
    except Exception:
        return {}


def _build_trace_url(host: str, trace_id: str | None) -> str | None:
    if not trace_id:
        return None
    if not host:
        return None
    return f"{host.rstrip('/')}/trace/{trace_id}"


def _atomic_write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    fd, tmp_path = tempfile.mkstemp(prefix=f"{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp_path, path)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def _is_enabled() -> bool:
    return os.getenv("TRACE_TO_LANGFUSE", "").lower() == "true"


def main() -> int:
    try:
        if not _is_enabled():
            return 0

        public_key = os.getenv("LANGFUSE_PUBLIC_KEY")
        secret_key = os.getenv("LANGFUSE_SECRET_KEY")
        if not public_key or not secret_key:
            return 0

        host = (
            os.getenv("LANGFUSE_BASE_URL")
            or os.getenv("LANGFUSE_HOST")
            or "https://cloud.langfuse.com"
        ).rstrip("/")

        payload = _read_payload()
        session_id = _extract_session_id(payload)
        transcript_path = _extract_transcript_path(payload)
        repo_root = _find_repo_root(payload, transcript_path)

        events = _load_transcript_events(transcript_path)
        turn_number, assistant_output = _extract_turn(events)

        current_session_path = repo_root / ".langfuse" / "current-session.json"
        existing_session = _load_existing_session(current_session_path, session_id)
        existing_trace_id = existing_session.get("trace_id") if isinstance(existing_session.get("trace_id"), str) else None

        from langfuse import Langfuse

        langfuse = Langfuse(
            public_key=public_key,
            secret_key=secret_key,
            host=host,
        )

        metadata = {
            "session_id": session_id,
            "source": "claude-code",
            "turn_number": turn_number,
        }

        observation_kwargs = {
            "name": f"Claude Code - Turn {turn_number}",
            "as_type": "span",
            "metadata": metadata,
        }

        if assistant_output:
            observation_kwargs["output"] = assistant_output

        if existing_trace_id:
            observation_kwargs["trace_context"] = {"trace_id": existing_trace_id}

        trace_id = existing_trace_id

        try:
            with langfuse.start_as_current_observation(**observation_kwargs) as observation:
                trace_id = getattr(observation, "trace_id", None) or existing_trace_id
        except TypeError:
            # Older SDKs may not support trace_context.
            observation_kwargs.pop("trace_context", None)
            with langfuse.start_as_current_observation(**observation_kwargs) as observation:
                trace_id = getattr(observation, "trace_id", None) or existing_trace_id

        langfuse.flush()
        langfuse.shutdown()

        trace_url = None
        get_trace_url = getattr(langfuse, "get_trace_url", None)
        if callable(get_trace_url) and trace_id:
            try:
                trace_url = get_trace_url(trace_id)
            except Exception:
                trace_url = _build_trace_url(host, trace_id)
        else:
            trace_url = _build_trace_url(host, trace_id)

        if session_id and trace_id:
            payload = {
                "schema_version": 1,
                "session_id": session_id,
                "trace_id": trace_id,
                "trace_url": trace_url,
                "host": host,
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "source": "claude-code",
            }
            _atomic_write_json(current_session_path, payload)

        return 0
    except Exception as exc:
        _debug(str(exc))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;

export const GIT_COMMIT_HOOK_SCRIPT = String.raw`#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

GIT_COMMIT_RE = re.compile(r"^git(?:\s+-C\s+\S+)?\s+commit(?:\s|$)")


def _debug(message: str) -> None:
    if os.getenv("LANGFUSE_CLAUDE_HOOK_DEBUG", "").lower() == "true":
        print(f"[langfuse_git_commit_hook] {message}", file=sys.stderr)


def _read_payload() -> dict:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


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
        nested = _command_succeeded(result)
        return nested

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

    try:
        output = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=cwd,
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        if output:
            return Path(output)
    except Exception:
        pass

    return Path(cwd).expanduser().resolve()


def _run_git(repo_root: Path, args: list[str]) -> str | None:
    try:
        output = subprocess.check_output(
            ["git", *args],
            cwd=str(repo_root),
            stderr=subprocess.DEVNULL,
            text=True,
        )
        return output.strip()
    except Exception:
        return None


def _head_changed_from_orig_head(repo_root: Path, head_sha: str) -> bool:
    orig_head = _run_git(repo_root, ["rev-parse", "ORIG_HEAD"])
    if orig_head and orig_head == head_sha:
        return False
    return True


def _first_remote(repo_root: Path) -> str | None:
    remotes = _run_git(repo_root, ["remote"])
    if not remotes:
        return None

    for line in remotes.splitlines():
        remote = line.strip()
        if remote:
            return remote

    return None


def _build_github_commit_url(remote_url: str | None, commit_sha: str) -> str | None:
    if not remote_url:
        return None

    remote = remote_url.strip()
    if not remote:
        return None

    patterns = [
        r"^https?://github\.com/(.+?)(?:\.git)?/?$",
        r"^git@github\.com:(.+?)(?:\.git)?$",
        r"^ssh://git@github\.com/(.+?)(?:\.git)?/?$",
    ]

    for pattern in patterns:
        match = re.match(pattern, remote, re.IGNORECASE)
        if match and match.group(1):
            return f"https://github.com/{match.group(1)}/commit/{commit_sha}"

    return None


def _atomic_write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    fd, tmp_path = tempfile.mkstemp(prefix=f"{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp_path, path)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def _extract_host(trace_url: str | None) -> str | None:
    if not trace_url or "://" not in trace_url:
        return None

    before_trace = trace_url.split("/trace/")[0]
    return before_trace.rstrip("/") if before_trace else None


def _enabled() -> bool:
    return os.getenv("TRACE_TO_LANGFUSE", "").lower() == "true"


def main() -> int:
    try:
        if not _enabled():
            return 0

        payload = _read_payload()
        if _extract_tool_name(payload) != "Bash":
            return 0

        command = _extract_command(payload).strip()
        if not command or not GIT_COMMIT_RE.match(command):
            return 0

        command_success = _command_succeeded(payload)
        if command_success is False:
            return 0

        public_key = os.getenv("LANGFUSE_PUBLIC_KEY")
        secret_key = os.getenv("LANGFUSE_SECRET_KEY")
        if not public_key or not secret_key:
            return 0

        host = (
            os.getenv("LANGFUSE_BASE_URL")
            or os.getenv("LANGFUSE_HOST")
            or "https://cloud.langfuse.com"
        ).rstrip("/")

        repo_root = _find_repo_root(payload)
        session_path = repo_root / ".langfuse" / "current-session.json"

        if not session_path.exists():
            return 0

        try:
            session_data = json.loads(session_path.read_text(encoding="utf-8"))
        except Exception:
            return 0

        if not isinstance(session_data, dict):
            return 0

        session_id = session_data.get("session_id")
        trace_id = session_data.get("trace_id")
        trace_url = session_data.get("trace_url")

        if not isinstance(session_id, str) or not session_id:
            return 0
        if not isinstance(trace_id, str) or not trace_id:
            return 0
        if not isinstance(trace_url, str) or not trace_url:
            trace_url = f"{host}/trace/{trace_id}"

        commit_sha = _run_git(repo_root, ["rev-parse", "HEAD"])
        if not commit_sha:
            return 0

        if command_success is None and not _head_changed_from_orig_head(repo_root, commit_sha):
            return 0

        branch = _run_git(repo_root, ["rev-parse", "--abbrev-ref", "HEAD"]) or "unknown"
        commit_message = _run_git(repo_root, ["log", "-1", "--pretty=%s"]) or ""

        remote_url = _run_git(repo_root, ["remote", "get-url", "origin"])
        if not remote_url:
            remote_name = _first_remote(repo_root)
            if remote_name:
                remote_url = _run_git(repo_root, ["remote", "get-url", remote_name])

        commit_url = _build_github_commit_url(remote_url, commit_sha)

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
            from langfuse import Langfuse

            langfuse = Langfuse(
                public_key=public_key,
                secret_key=secret_key,
                host=host,
            )

            observation_kwargs = {
                "as_type": "span",
                "name": "git-commit",
                "trace_context": {"trace_id": trace_id},
                "metadata": metadata,
            }

            try:
                with langfuse.start_as_current_observation(**observation_kwargs):
                    pass
            except TypeError:
                observation_kwargs.pop("trace_context", None)
                with langfuse.start_as_current_observation(**observation_kwargs):
                    pass

            langfuse.flush()
            langfuse.shutdown()
        except Exception as exc:
            _debug(str(exc))

        manifest = {
            "schema_version": 1,
            "langfuse": {
                "trace_id": trace_id,
                "trace_url": trace_url,
                "session_id": session_id,
                "host": _extract_host(trace_url) or host,
            },
            "git": {
                "commit_sha": commit_sha,
                "commit_url": commit_url,
                "commit_message": commit_message,
                "branch": branch,
                "remote_url": remote_url,
            },
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

        manifests_dir = repo_root / ".langfuse" / "traces"
        safe_session_id = re.sub(r"[^A-Za-z0-9._-]", "_", session_id)
        manifest_path = manifests_dir / f"{safe_session_id}.json"
        _atomic_write_json(manifest_path, manifest)

        return 0
    except Exception as exc:
        _debug(str(exc))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;

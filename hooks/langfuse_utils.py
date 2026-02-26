#!/usr/bin/env python3
"""Shared utilities for Langfuse Claude Code hooks.

Installed by langfuse-cli. All hook scripts import from this module.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# --------------- Configuration ---------------
HOOK_DEBUG_ENV = "LANGFUSE_HOOK_DEBUG"
DEBUG = os.environ.get(HOOK_DEBUG_ENV, "").lower() == "true"

STATE_DIR = Path.home() / ".claude" / "state"
LOG_FILE = STATE_DIR / "langfuse_hook.log"
STATE_FILE = STATE_DIR / "langfuse_state.json"
LOCK_FILE = STATE_DIR / "langfuse_state.lock"
LAST_TRACE_FILE = STATE_DIR / "langfuse_last_trace.json"

MAX_CHARS = int(os.environ.get("LANGFUSE_HOOK_MAX_CHARS", "20000"))


# --------------- Logging ---------------
def _log(level: str, message: str) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"{ts} [{level}] {message}\n")
    except Exception:
        pass


def debug(msg: str) -> None:
    if DEBUG:
        _log("DEBUG", msg)


def info(msg: str) -> None:
    _log("INFO", msg)


def warn(msg: str) -> None:
    _log("WARN", msg)


def error(msg: str) -> None:
    _log("ERROR", msg)


# --------------- Environment ---------------
def tracing_enabled() -> bool:
    return os.environ.get("TRACE_TO_LANGFUSE", "").lower() == "true"


def get_langfuse_credentials() -> Optional[Dict[str, str]]:
    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY")
    secret_key = os.environ.get("LANGFUSE_SECRET_KEY")
    if not public_key or not secret_key:
        return None
    host = (
        os.environ.get("LANGFUSE_BASE_URL")
        or os.environ.get("LANGFUSE_HOST")
        or "https://cloud.langfuse.com"
    ).rstrip("/")
    return {"public_key": public_key, "secret_key": secret_key, "host": host}


# --------------- Hook payload ---------------
def read_hook_payload() -> Dict[str, Any]:
    try:
        data = sys.stdin.read()
        if not data.strip():
            return {}
        return json.loads(data)
    except Exception:
        return {}


def extract_session_id(payload: Dict[str, Any]) -> Optional[str]:
    return (
        payload.get("sessionId")
        or payload.get("session_id")
        or (payload.get("session") or {}).get("id")
    )


def extract_transcript_path(payload: Dict[str, Any]) -> Optional[Path]:
    transcript = (
        payload.get("transcriptPath")
        or payload.get("transcript_path")
        or (payload.get("transcript") or {}).get("path")
    )
    if not transcript:
        return None
    try:
        return Path(transcript).expanduser().resolve()
    except Exception:
        return None


# --------------- Git helpers ---------------
def run_git(cwd: Path, args: List[str]) -> Optional[str]:
    try:
        output = subprocess.check_output(
            ["git", *args],
            cwd=str(cwd),
            stderr=subprocess.DEVNULL,
            text=True,
        )
        value = output.strip()
        return value or None
    except Exception:
        return None


def resolve_repo_root(search_path: Path) -> Optional[Path]:
    cwd = search_path.parent if search_path.is_file() else search_path
    root = run_git(cwd, ["rev-parse", "--show-toplevel"])
    if not root:
        return None
    try:
        return Path(root).expanduser().resolve()
    except Exception:
        return None


def first_remote(repo_root: Path) -> Optional[str]:
    remotes = run_git(repo_root, ["remote"])
    if not remotes:
        return None
    for line in remotes.splitlines():
        remote = line.strip()
        if remote:
            return remote
    return None


def build_github_commit_url(remote_url: Optional[str], commit_sha: str) -> Optional[str]:
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


def get_remote_url(repo_root: Path) -> Optional[str]:
    remote_url = run_git(repo_root, ["remote", "get-url", "origin"])
    if not remote_url:
        remote_name = first_remote(repo_root)
        if remote_name:
            remote_url = run_git(repo_root, ["remote", "get-url", remote_name])
    return remote_url


def resolve_repo_root_with_fallback(*paths: Path) -> Optional[Path]:
    """Try each path in order, returning the first that resolves to a git repo root."""
    for p in paths:
        root = resolve_repo_root(p)
        if root:
            return root
    return None


def get_git_metadata(*search_paths: Path) -> Dict[str, Any]:
    """Build git metadata from the first search path that resolves to a repo.

    Pass multiple candidates (e.g. transcript path, then cwd) so we find
    the repo even when the transcript lives outside the working tree.
    """
    repo_root = resolve_repo_root_with_fallback(*search_paths)
    if not repo_root:
        return {}
    commit_sha = run_git(repo_root, ["rev-parse", "HEAD"])
    if not commit_sha:
        return {}
    remote_url = get_remote_url(repo_root)
    commit_url = build_github_commit_url(remote_url, commit_sha)
    metadata: Dict[str, Any] = {
        "git_commit_sha": commit_sha,
        "git_remote_url": remote_url,
    }
    if commit_url:
        metadata["git_commit_url"] = commit_url
    return metadata


# --------------- Claude Code identity ---------------
_cached_user_email: Optional[str] = None


def get_claude_user_email() -> Optional[str]:
    """Resolve the Claude Code user's email address.

    Checks ~/.claude.json for stored auth data (oauthAccount.emailAddress),
    then falls back to running ``claude auth status`` and parsing the output.
    """
    global _cached_user_email
    if _cached_user_email is not None:
        return _cached_user_email or None

    email_keys = ("emailAddress", "email", "userEmail", "user_email")

    # 1) Try ~/.claude.json (Claude Code stores oauthAccount here)
    try:
        claude_json_path = Path.home() / ".claude.json"
        if claude_json_path.exists():
            data = json.loads(claude_json_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                # Check top-level keys
                for key in email_keys:
                    val = data.get(key)
                    if isinstance(val, str) and "@" in val:
                        _cached_user_email = val
                        return val
                # Check nested objects (oauthAccount, auth, user, etc.)
                for outer in ("oauthAccount", "auth", "oauth", "user", "account"):
                    nested = data.get(outer)
                    if isinstance(nested, dict):
                        for key in email_keys:
                            val = nested.get(key)
                            if isinstance(val, str) and "@" in val:
                                _cached_user_email = val
                                return val
    except Exception:
        pass

    # 2) Fallback: ``claude auth status``
    try:
        out = subprocess.check_output(
            ["claude", "auth", "status"],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        )
        # Try JSON output first
        try:
            status = json.loads(out.strip())
            if isinstance(status, dict):
                for key in email_keys:
                    val = status.get(key)
                    if isinstance(val, str) and "@" in val:
                        _cached_user_email = val
                        return val
        except (json.JSONDecodeError, ValueError):
            pass
        # Try plain text: "Logged in as user@example.com"
        import re as _re
        match = _re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", out)
        if match:
            _cached_user_email = match.group(0)
            return _cached_user_email
    except Exception:
        pass

    _cached_user_email = ""
    return None


# --------------- File I/O ---------------
def atomic_write_json(path: Path, data: dict) -> None:
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


def save_last_trace(session_id: str, trace_id: str, host: str) -> None:
    try:
        project_id = os.environ.get("LANGFUSE_PROJECT_ID", "")

        data: Dict[str, Any] = {
            "session_id": session_id,
            "trace_id": trace_id,
            "trace_url": f"{host}/trace/{trace_id}",
            "host": host,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

        if project_id:
            data["project_id"] = project_id
            data["session_url"] = f"{host}/project/{project_id}/sessions/{session_id}"

        STATE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = LAST_TRACE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        os.replace(tmp, LAST_TRACE_FILE)
    except Exception as e:
        debug(f"save_last_trace failed: {e}")


def read_last_trace(expected_session_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Read the last trace file, optionally validating the session_id matches."""
    if not LAST_TRACE_FILE.exists():
        return None
    try:
        data = json.loads(LAST_TRACE_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not data.get("trace_id"):
            return None
        if expected_session_id and data.get("session_id") != expected_session_id:
            return None
        return data
    except Exception:
        return None


def _parse_iso_utc(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        ts = datetime.fromisoformat(value)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return ts.astimezone(timezone.utc)
    except Exception:
        return None


def read_recent_trace(
    path: Path,
    max_age_hours: float,
    expected_session_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Read a trace file if present and recent enough."""
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None

    if not isinstance(data, dict):
        return None

    trace_id = data.get("trace_id")
    trace_url = data.get("trace_url")
    if not isinstance(trace_id, str) or not trace_id:
        return None
    if not isinstance(trace_url, str) or not trace_url:
        return None

    if expected_session_id and data.get("session_id") != expected_session_id:
        return None

    updated_at = _parse_iso_utc(data.get("updated_at"))
    if updated_at is None:
        return None

    age_hours = (datetime.now(timezone.utc) - updated_at).total_seconds() / 3600
    if age_hours > max_age_hours:
        return None

    return data


# --------------- Trace manifest ---------------
def write_trace_manifest(
    repo_root: Path,
    session_id: str,
    trace_id: str,
    host: str,
    git_metadata: Optional[Dict[str, Any]] = None,
) -> None:
    try:
        safe_sid = re.sub(r"[^A-Za-z0-9._-]", "_", session_id)
        manifest_dir = repo_root / ".langfuse" / "traces"
        manifest_path = manifest_dir / f"{safe_sid}.json"

        existing: Dict[str, Any] = {}
        if manifest_path.exists():
            try:
                existing = json.loads(manifest_path.read_text(encoding="utf-8"))
            except Exception:
                pass

        trace_url = f"{host}/trace/{trace_id}"
        project_id = os.environ.get("LANGFUSE_PROJECT_ID", "")
        session_url = f"{host}/project/{project_id}/sessions/{session_id}" if project_id else ""

        commit_sha = (git_metadata or {}).get("git_commit_sha", "")
        remote_url = (git_metadata or {}).get("git_remote_url")
        commit_url = (git_metadata or {}).get("git_commit_url")

        git_block = existing.get("git", {}) if isinstance(existing.get("git"), dict) else {}
        if commit_sha:
            git_block["commit_sha"] = commit_sha
            if commit_url:
                git_block["commit_url"] = commit_url
            if remote_url:
                git_block["remote_url"] = remote_url
            branch = run_git(repo_root, ["rev-parse", "--abbrev-ref", "HEAD"])
            if branch:
                git_block["branch"] = branch
            msg = run_git(repo_root, ["log", "-1", "--pretty=%s"])
            if msg:
                git_block["commit_message"] = msg

        langfuse_block: Dict[str, Any] = {
            "trace_id": trace_id,
            "trace_url": trace_url,
            "session_id": session_id,
            "host": host.rstrip("/"),
        }
        if session_url:
            langfuse_block["session_url"] = session_url

        manifest = {
            "schema_version": 1,
            "langfuse": langfuse_block,
            "git": git_block,
            "created_at": existing.get("created_at", datetime.now(timezone.utc).isoformat()),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

        atomic_write_json(manifest_path, manifest)

        current_session_data: Dict[str, Any] = {
            "session_id": session_id,
            "trace_id": trace_id,
            "trace_url": trace_url,
            "host": host.rstrip("/"),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        if session_url:
            current_session_data["session_url"] = session_url

        current_session_path = repo_root / ".langfuse" / "current-session.json"
        atomic_write_json(current_session_path, current_session_data)
        debug(f"Wrote trace manifest to {manifest_path}")
    except Exception as exc:
        debug(f"write_trace_manifest failed: {exc}")

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


def get_git_metadata(search_path: Path) -> Dict[str, Any]:
    repo_root = resolve_repo_root(search_path)
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
        data = {
            "session_id": session_id,
            "trace_id": trace_id,
            "trace_url": f"{host}/trace/{trace_id}",
            "host": host,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
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

        manifest = {
            "schema_version": 1,
            "langfuse": {
                "trace_id": trace_id,
                "trace_url": trace_url,
                "session_id": session_id,
                "host": host.rstrip("/"),
            },
            "git": git_block,
            "created_at": existing.get("created_at", datetime.now(timezone.utc).isoformat()),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

        atomic_write_json(manifest_path, manifest)
        debug(f"Wrote trace manifest to {manifest_path}")
    except Exception as exc:
        debug(f"write_trace_manifest failed: {exc}")

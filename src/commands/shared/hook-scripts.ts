export const STOP_HOOK_SCRIPT = String.raw`#!/usr/bin/env python3
"""
Claude Code -> Langfuse hook

"""

import json
import os
import sys
import time
import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# --- Langfuse import (fail-open) ---
try:
    from langfuse import Langfuse, propagate_attributes
except Exception:
    sys.exit(0)

# --- Paths ---
STATE_DIR = Path.home() / ".claude" / "state"
LOG_FILE = STATE_DIR / "langfuse_hook.log"
STATE_FILE = STATE_DIR / "langfuse_state.json"
LOCK_FILE = STATE_DIR / "langfuse_state.lock"
LAST_TRACE_FILE = STATE_DIR / "langfuse_last_trace.json"

DEBUG = os.environ.get("CC_LANGFUSE_DEBUG", "").lower() == "true"
MAX_CHARS = int(os.environ.get("CC_LANGFUSE_MAX_CHARS", "20000"))

# ----------------- Logging -----------------
def _log(level: str, message: str) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"{ts} [{level}] {message}\n")
    except Exception:
        # Never block
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

# ----------------- State locking (best-effort) -----------------
class FileLock:
    def __init__(self, path: Path, timeout_s: float = 2.0):
        self.path = path
        self.timeout_s = timeout_s
        self._fh = None

    def __enter__(self):
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        self._fh = open(self.path, "a+", encoding="utf-8")
        try:
            import fcntl  # Unix only
            deadline = time.time() + self.timeout_s
            while True:
                try:
                    fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.time() > deadline:
                        break
                    time.sleep(0.05)
        except Exception:
            # If locking isn't available, proceed without it.
            pass
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            import fcntl
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
        except Exception:
            pass
        try:
            self._fh.close()
        except Exception:
            pass

def load_state() -> Dict[str, Any]:
    try:
        if not STATE_FILE.exists():
            return {}
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}

def save_state(state: Dict[str, Any]) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(tmp, STATE_FILE)
    except Exception as e:
        debug(f"save_state failed: {e}")

def save_last_trace(session_id: str, trace_id: str, host: str) -> None:
    """Persist the latest trace info so prepare-commit-msg can pick it up."""
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

def state_key(session_id: str, transcript_path: str) -> str:
    # stable key even if session_id collides
    raw = f"{session_id}::{transcript_path}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()

# ----------------- Hook payload -----------------
def read_hook_payload() -> Dict[str, Any]:
    """
    Claude Code hooks pass a JSON payload on stdin.
    This script tolerates missing/empty stdin by returning {}.
    """
    try:
        data = sys.stdin.read()
        if not data.strip():
            return {}
        return json.loads(data)
    except Exception:
        return {}

def extract_session_and_transcript(payload: Dict[str, Any]) -> Tuple[Optional[str], Optional[Path]]:
    """
    Tries a few plausible field names; exact keys can vary across hook types/versions.
    Prefer structured values from stdin over heuristics.
    """
    session_id = (
        payload.get("sessionId")
        or payload.get("session_id")
        or payload.get("session", {}).get("id")
    )

    transcript = (
        payload.get("transcriptPath")
        or payload.get("transcript_path")
        or payload.get("transcript", {}).get("path")
    )

    if transcript:
        try:
            transcript_path = Path(transcript).expanduser().resolve()
        except Exception:
            transcript_path = None
    else:
        transcript_path = None

    return session_id, transcript_path

# ----------------- Transcript parsing helpers -----------------
def get_content(msg: Dict[str, Any]) -> Any:
    if not isinstance(msg, dict):
        return None
    if "message" in msg and isinstance(msg.get("message"), dict):
        return msg["message"].get("content")
    return msg.get("content")

def get_role(msg: Dict[str, Any]) -> Optional[str]:
    # Claude Code transcript lines commonly have type=user/assistant OR message.role
    t = msg.get("type")
    if t in ("user", "assistant"):
        return t
    m = msg.get("message")
    if isinstance(m, dict):
        r = m.get("role")
        if r in ("user", "assistant"):
            return r
    return None

def is_tool_result(msg: Dict[str, Any]) -> bool:
    role = get_role(msg)
    if role != "user":
        return False
    content = get_content(msg)
    if isinstance(content, list):
        return any(isinstance(x, dict) and x.get("type") == "tool_result" for x in content)
    return False

def iter_tool_results(content: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if isinstance(content, list):
        for x in content:
            if isinstance(x, dict) and x.get("type") == "tool_result":
                out.append(x)
    return out

def iter_tool_uses(content: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if isinstance(content, list):
        for x in content:
            if isinstance(x, dict) and x.get("type") == "tool_use":
                out.append(x)
    return out

def extract_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for x in content:
            if isinstance(x, dict) and x.get("type") == "text":
                parts.append(x.get("text", ""))
            elif isinstance(x, str):
                parts.append(x)
        return "\n".join([p for p in parts if p])
    return ""

def truncate_text(s: str, max_chars: int = MAX_CHARS) -> Tuple[str, Dict[str, Any]]:
    if s is None:
        return "", {"truncated": False, "orig_len": 0}
    orig_len = len(s)
    if orig_len <= max_chars:
        return s, {"truncated": False, "orig_len": orig_len}
    head = s[:max_chars]
    return head, {"truncated": True, "orig_len": orig_len, "kept_len": len(head), "sha256": hashlib.sha256(s.encode("utf-8")).hexdigest()}

def get_model(msg: Dict[str, Any]) -> str:
    m = msg.get("message")
    if isinstance(m, dict):
        return m.get("model") or "claude"
    return "claude"

def get_message_id(msg: Dict[str, Any]) -> Optional[str]:
    m = msg.get("message")
    if isinstance(m, dict):
        mid = m.get("id")
        if isinstance(mid, str) and mid:
            return mid
    return None

# ----------------- Incremental reader -----------------
@dataclass
class SessionState:
    offset: int = 0
    buffer: str = ""
    turn_count: int = 0

def load_session_state(global_state: Dict[str, Any], key: str) -> SessionState:
    s = global_state.get(key, {})
    return SessionState(
        offset=int(s.get("offset", 0)),
        buffer=str(s.get("buffer", "")),
        turn_count=int(s.get("turn_count", 0)),
    )

def write_session_state(global_state: Dict[str, Any], key: str, ss: SessionState) -> None:
    global_state[key] = {
        "offset": ss.offset,
        "buffer": ss.buffer,
        "turn_count": ss.turn_count,
        "updated": datetime.now(timezone.utc).isoformat(),
    }

def read_new_jsonl(transcript_path: Path, ss: SessionState) -> Tuple[List[Dict[str, Any]], SessionState]:
    """
    Reads only new bytes since ss.offset. Keeps ss.buffer for partial last line.
    Returns parsed JSON lines (best-effort) and updated state.
    """
    if not transcript_path.exists():
        return [], ss

    try:
        with open(transcript_path, "rb") as f:
            f.seek(ss.offset)
            chunk = f.read()
            new_offset = f.tell()
    except Exception as e:
        debug(f"read_new_jsonl failed: {e}")
        return [], ss

    if not chunk:
        return [], ss

    try:
        text = chunk.decode("utf-8", errors="replace")
    except Exception:
        text = chunk.decode(errors="replace")

    combined = ss.buffer + text
    lines = combined.split("\n")
    # last element may be incomplete
    ss.buffer = lines[-1]
    ss.offset = new_offset

    msgs: List[Dict[str, Any]] = []
    for line in lines[:-1]:
        line = line.strip()
        if not line:
            continue
        try:
            msgs.append(json.loads(line))
        except Exception:
            continue

    return msgs, ss

# ----------------- Turn assembly -----------------
@dataclass
class Turn:
    user_msg: Dict[str, Any]
    assistant_msgs: List[Dict[str, Any]]
    tool_results_by_id: Dict[str, Any]

def build_turns(messages: List[Dict[str, Any]]) -> List[Turn]:
    """
    Groups incremental transcript rows into turns:
    user (non-tool-result) -> assistant messages -> (tool_result rows, possibly interleaved)
    Uses:
    - assistant message dedupe by message.id (latest row wins)
    - tool results dedupe by tool_use_id (latest wins)
    """
    turns: List[Turn] = []
    current_user: Optional[Dict[str, Any]] = None

    # assistant messages for current turn:
    assistant_order: List[str] = []             # message ids in order of first appearance (or synthetic)
    assistant_latest: Dict[str, Dict[str, Any]] = {}  # id -> latest msg

    tool_results_by_id: Dict[str, Any] = {}     # tool_use_id -> content

    def flush_turn():
        nonlocal current_user, assistant_order, assistant_latest, tool_results_by_id, turns
        if current_user is None:
            return
        if not assistant_latest:
            return
        assistants = [assistant_latest[mid] for mid in assistant_order if mid in assistant_latest]
        turns.append(Turn(user_msg=current_user, assistant_msgs=assistants, tool_results_by_id=dict(tool_results_by_id)))

    for msg in messages:
        role = get_role(msg)

        # tool_result rows show up as role=user with content blocks of type tool_result
        if is_tool_result(msg):
            for tr in iter_tool_results(get_content(msg)):
                tid = tr.get("tool_use_id")
                if tid:
                    tool_results_by_id[str(tid)] = tr.get("content")
            continue

        if role == "user":
            # new user message -> finalize previous turn
            flush_turn()

            # start a new turn
            current_user = msg
            assistant_order = []
            assistant_latest = {}
            tool_results_by_id = {}
            continue

        if role == "assistant":
            if current_user is None:
                # ignore assistant rows until we see a user message
                continue

            mid = get_message_id(msg) or f"noid:{len(assistant_order)}"
            if mid not in assistant_latest:
                assistant_order.append(mid)
            assistant_latest[mid] = msg
            continue

        # ignore unknown rows

    # flush last
    flush_turn()
    return turns

# ----------------- Langfuse emit -----------------
def _tool_calls_from_assistants(assistant_msgs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    calls: List[Dict[str, Any]] = []
    for am in assistant_msgs:
        for tu in iter_tool_uses(get_content(am)):
            tid = tu.get("id") or ""
            calls.append({
                "id": str(tid),
                "name": tu.get("name") or "unknown",
                "input": tu.get("input") if isinstance(tu.get("input"), (dict, list, str, int, float, bool)) else {},
            })
    return calls

def emit_turn(langfuse: Langfuse, session_id: str, turn_num: int, turn: Turn, transcript_path: Path, pre_trace_id: Optional[str] = None) -> Optional[str]:
    user_text_raw = extract_text(get_content(turn.user_msg))
    user_text, user_text_meta = truncate_text(user_text_raw)

    last_assistant = turn.assistant_msgs[-1]
    assistant_text_raw = extract_text(get_content(last_assistant))
    assistant_text, assistant_text_meta = truncate_text(assistant_text_raw)

    model = get_model(turn.assistant_msgs[0])

    tool_calls = _tool_calls_from_assistants(turn.assistant_msgs)

    # attach tool outputs
    for c in tool_calls:
        if c["id"] and c["id"] in turn.tool_results_by_id:
            out_raw = turn.tool_results_by_id[c["id"]]
            out_str = out_raw if isinstance(out_raw, str) else json.dumps(out_raw, ensure_ascii=False)
            out_trunc, out_meta = truncate_text(out_str)
            c["output"] = out_trunc
            c["output_meta"] = out_meta
        else:
            c["output"] = None

    span_metadata = {
        "source": "claude-code",
        "session_id": session_id,
        "turn_number": turn_num,
        "transcript_path": str(transcript_path),
        "user_text": user_text_meta,
    }

    with propagate_attributes(
        session_id=session_id,
        trace_name=f"Claude Code - Turn {turn_num}",
        tags=["claude-code"],
    ):
        # When a pre-generated trace_id is available (from the session-init hook),
        # use start_as_current_observation with trace_context so the turn is
        # recorded under that deterministic trace rather than an auto-generated one.
        if pre_trace_id:
            obs_kwargs = {
                "as_type": "span",
                "name": f"Claude Code - Turn {turn_num}",
                "input": {"role": "user", "content": user_text},
                "metadata": span_metadata,
                "trace_context": {"trace_id": pre_trace_id},
            }
            try:
                span_ctx = langfuse.start_as_current_observation(**obs_kwargs)
            except TypeError:
                obs_kwargs.pop("trace_context", None)
                span_ctx = langfuse.start_as_current_observation(**obs_kwargs)
        else:
            span_ctx = langfuse.start_as_current_span(
                name=f"Claude Code - Turn {turn_num}",
                input={"role": "user", "content": user_text},
                metadata=span_metadata,
            )

        with span_ctx as trace_span:
            # LLM generation
            with langfuse.start_as_current_observation(
                name="Claude Response",
                as_type="generation",
                model=model,
                input={"role": "user", "content": user_text},
                output={"role": "assistant", "content": assistant_text},
                metadata={
                    "assistant_text": assistant_text_meta,
                    "tool_count": len(tool_calls),
                },
            ):
                pass

            # Tool observations
            for tc in tool_calls:
                in_obj = tc["input"]
                # truncate tool input if it's a large string payload
                if isinstance(in_obj, str):
                    in_obj, in_meta = truncate_text(in_obj)
                else:
                    in_meta = None

                with langfuse.start_as_current_observation(
                    name=f"Tool: {tc['name']}",
                    as_type="tool",
                    input=in_obj,
                    metadata={
                        "tool_name": tc["name"],
                        "tool_id": tc["id"],
                        "input_meta": in_meta,
                        "output_meta": tc.get("output_meta"),
                    },
                ) as tool_obs:
                    tool_obs.update(output=tc.get("output"))

            trace_span.update(output={"role": "assistant", "content": assistant_text})
            return getattr(trace_span, "trace_id", None)

# ----------------- Main -----------------
def main() -> int:
    start = time.time()
    debug("Hook started")

    if os.environ.get("TRACE_TO_LANGFUSE", "").lower() != "true":
        return 0

    public_key = os.environ.get("CC_LANGFUSE_PUBLIC_KEY") or os.environ.get("LANGFUSE_PUBLIC_KEY")
    secret_key = os.environ.get("CC_LANGFUSE_SECRET_KEY") or os.environ.get("LANGFUSE_SECRET_KEY")
    host = os.environ.get("CC_LANGFUSE_BASE_URL") or os.environ.get("LANGFUSE_BASE_URL") or "https://cloud.langfuse.com"

    if not public_key or not secret_key:
        return 0

    payload = read_hook_payload()
    session_id, transcript_path = extract_session_and_transcript(payload)

    if not session_id or not transcript_path:
        # No structured payload; fail open (do not guess)
        debug("Missing session_id or transcript_path from hook payload; exiting.")
        return 0

    if not transcript_path.exists():
        debug(f"Transcript path does not exist: {transcript_path}")
        return 0

    try:
        langfuse = Langfuse(public_key=public_key, secret_key=secret_key, host=host)
    except Exception:
        return 0

    # Read pre-generated trace_id from session-init hook (if available)
    pre_trace_id = None
    if LAST_TRACE_FILE.exists():
        try:
            lt_data = json.loads(LAST_TRACE_FILE.read_text(encoding="utf-8"))
            if isinstance(lt_data, dict) and lt_data.get("session_id") == session_id:
                pre_trace_id = lt_data.get("trace_id")
                debug(f"Using pre-generated trace_id: {pre_trace_id}")
        except Exception:
            pass

    try:
        with FileLock(LOCK_FILE):
            state = load_state()
            key = state_key(session_id, str(transcript_path))
            ss = load_session_state(state, key)

            msgs, ss = read_new_jsonl(transcript_path, ss)
            if not msgs:
                write_session_state(state, key, ss)
                save_state(state)
                return 0

            turns = build_turns(msgs)
            if not turns:
                write_session_state(state, key, ss)
                save_state(state)
                return 0

            # emit turns
            emitted = 0
            last_trace_id = None
            for t in turns:
                emitted += 1
                turn_num = ss.turn_count + emitted
                try:
                    tid = emit_turn(langfuse, session_id, turn_num, t, transcript_path, pre_trace_id=pre_trace_id)
                    if tid:
                        last_trace_id = tid
                except Exception as e:
                    debug(f"emit_turn failed: {e}")
                    # continue emitting other turns

            ss.turn_count += emitted
            write_session_state(state, key, ss)
            save_state(state)

        try:
            langfuse.flush()
        except Exception:
            pass

        if last_trace_id:
            save_last_trace(session_id, last_trace_id, host)
        elif pre_trace_id:
            save_last_trace(session_id, pre_trace_id, host)

        dur = time.time() - start
        info(f"Processed {emitted} turns in {dur:.2f}s (session={session_id})")
        return 0

    except Exception as e:
        debug(f"Unexpected failure: {e}")
        return 0

    finally:
        try:
            langfuse.shutdown()
        except Exception:
            pass

if __name__ == "__main__":
    sys.exit(main())
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


def _build_release_tag(
    commit_sha: str,
    commit_url: str | None,
    trace_url: str | None,
) -> str:
    short_sha = commit_sha[:7]
    parts = [short_sha]
    if commit_url:
        parts.append(commit_url)
    if trace_url:
        parts.append(trace_url)
    return " | ".join(parts)


def _update_env_release(repo_root: Path, release_value: str) -> None:
    env_path = repo_root / ".env.local"
    lines: list[str] = []
    found = False

    if env_path.exists():
        try:
            content = env_path.read_text(encoding="utf-8")
            for line in content.splitlines():
                if line.startswith("LANGFUSE_RELEASE="):
                    lines.append(f"LANGFUSE_RELEASE={release_value}")
                    found = True
                else:
                    lines.append(line)
        except Exception:
            pass

    if not found:
        lines.append(f"LANGFUSE_RELEASE={release_value}")

    try:
        env_path.parent.mkdir(parents=True, exist_ok=True)
        env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        _debug(f"Updated LANGFUSE_RELEASE in {env_path}")
    except Exception as exc:
        _debug(f"Failed to update {env_path}: {exc}")


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

        # Primary: global last-trace state file (written by Stop hook)
        last_trace_path = Path.home() / ".claude" / "state" / "langfuse_last_trace.json"
        # Legacy fallback: per-repo session file
        legacy_session_path = repo_root / ".langfuse" / "current-session.json"

        session_data = None
        for candidate in (last_trace_path, legacy_session_path):
            if not candidate.exists():
                continue
            try:
                data = json.loads(candidate.read_text(encoding="utf-8"))
                if isinstance(data, dict) and data.get("trace_id"):
                    session_data = data
                    break
            except Exception:
                continue

        if not session_data:
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

        release_tag = _build_release_tag(commit_sha, commit_url, trace_url)
        _update_env_release(repo_root, release_tag)

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

export const PREPARE_COMMIT_MSG_HOOK_SCRIPT = String.raw`#!/usr/bin/env python3
"""
prepare-commit-msg hook: appends a Langfuse-Trace trailer to commit messages.
Installed by langfuse-cli.
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

LAST_TRACE_FILE = Path.home() / ".claude" / "state" / "langfuse_last_trace.json"
MAX_AGE_HOURS = 4
TRAILER_KEY = "Langfuse-Trace"


def main() -> int:
    try:
        # Gate: only run when tracing is enabled (Claude Code sessions set this)
        if os.environ.get("TRACE_TO_LANGFUSE", "").lower() != "true":
            return 0

        # Arg parsing: prepare-commit-msg <msg_file> [<commit_source>] [<sha>]
        if len(sys.argv) < 2:
            return 0

        msg_file = sys.argv[1]
        commit_source = sys.argv[2] if len(sys.argv) > 2 else ""

        # Skip merge/squash commits
        if commit_source in ("merge", "squash"):
            return 0

        # Read last trace data
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

        # Staleness check
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
                pass  # If we can't parse the timestamp, skip staleness check

        # Read current commit message
        try:
            content = Path(msg_file).read_text(encoding="utf-8")
        except Exception:
            return 0

        # Check if trailer already present (amend safety)
        if f"{TRAILER_KEY}:" in content:
            return 0

        # Build trailer line
        trailer = f"{TRAILER_KEY}: {trace_url}"

        # Append trailer with proper formatting
        lines = content.rstrip("\n").split("\n")

        # Detect existing trailers at the end of the message
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
            # Add trailer right after existing trailers (no extra blank line needed)
            result = "\n".join(lines) + "\n" + trailer + "\n"
        else:
            # Add blank line separator before trailer block
            result = "\n".join(lines) + "\n\n" + trailer + "\n"

        Path(msg_file).write_text(result, encoding="utf-8")
        return 0

    except Exception:
        # Never block commits
        return 0


if __name__ == "__main__":
    sys.exit(main())
`;

export const PREPARE_COMMIT_MSG_WRAPPER_SCRIPT = `#!/bin/sh
# langfuse-trace-trailer — installed by langfuse-cli
python3 ~/.claude/hooks/langfuse_prepare_commit_msg.py "$@" 2>/dev/null || true
# Chain pre-existing hook if backed up
if [ -x "$(dirname "$0")/prepare-commit-msg.pre-langfuse" ]; then
    "$(dirname "$0")/prepare-commit-msg.pre-langfuse" "$@"
fi
`;

export const SESSION_INIT_HOOK_SCRIPT = String.raw`#!/usr/bin/env python3
"""
PreToolUse hook: eagerly initializes the Langfuse trace ID for the current
Claude Code session so that prepare-commit-msg can reference it immediately.

On the first tool use of a session, this hook:
1. Generates a deterministic trace_id from the session_id
2. Writes it to ~/.claude/state/langfuse_last_trace.json

Subsequent invocations detect the matching session_id and exit immediately.
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

STATE_DIR = Path.home() / ".claude" / "state"
LAST_TRACE_FILE = STATE_DIR / "langfuse_last_trace.json"


def main() -> int:
    try:
        if os.environ.get("TRACE_TO_LANGFUSE", "").lower() != "true":
            return 0

        # Read hook payload from stdin
        try:
            raw = sys.stdin.read()
            payload = json.loads(raw) if raw.strip() else {}
        except Exception:
            payload = {}

        session_id = (
            payload.get("sessionId")
            or payload.get("session_id")
            or (payload.get("session") or {}).get("id")
        )
        if not session_id:
            return 0

        # Fast path: if last_trace already belongs to this session, nothing to do
        if LAST_TRACE_FILE.exists():
            try:
                existing = json.loads(LAST_TRACE_FILE.read_text(encoding="utf-8"))
                if isinstance(existing, dict) and existing.get("session_id") == session_id:
                    return 0
            except Exception:
                pass

        # Resolve Langfuse credentials and host
        host = (
            os.environ.get("CC_LANGFUSE_BASE_URL")
            or os.environ.get("LANGFUSE_BASE_URL")
            or "https://cloud.langfuse.com"
        ).rstrip("/")
        public_key = os.environ.get("CC_LANGFUSE_PUBLIC_KEY") or os.environ.get("LANGFUSE_PUBLIC_KEY")
        secret_key = os.environ.get("CC_LANGFUSE_SECRET_KEY") or os.environ.get("LANGFUSE_SECRET_KEY")
        if not public_key or not secret_key:
            return 0

        # Generate a deterministic trace_id from the session_id.
        # Prefer the Langfuse SDK's create_trace_id (W3C-compatible 32-char hex)
        # with a fallback to MD5 for environments without the SDK or older versions.
        trace_id = None
        try:
            from langfuse import Langfuse
            lf = Langfuse(public_key=public_key, secret_key=secret_key, host=host)
            trace_id = lf.create_trace_id(seed=session_id)
            lf.shutdown()
        except Exception:
            pass

        if not trace_id:
            import hashlib
            trace_id = hashlib.md5(session_id.encode("utf-8")).hexdigest()

        # Persist the trace info so prepare-commit-msg and other hooks can use it
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

        return 0

    except Exception:
        # Never block tool execution
        return 0


if __name__ == "__main__":
    sys.exit(main())
`;

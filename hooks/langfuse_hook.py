#!/usr/bin/env python3
"""
Claude Code Stop hook -> Langfuse tracing.

Reads the conversation transcript incrementally and emits turns to Langfuse.
Installed by langfuse-cli.
"""

import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    from langfuse_utils import (
        DEBUG,
        LAST_TRACE_FILE,
        LOCK_FILE,
        MAX_CHARS,
        STATE_DIR,
        STATE_FILE,
        debug,
        error,
        extract_session_id,
        extract_transcript_path,
        get_claude_user_email,
        get_git_metadata,
        get_langfuse_credentials,
        info,
        read_hook_payload,
        read_last_trace,
        resolve_repo_root_with_fallback,
        save_last_trace,
        tracing_enabled,
        write_trace_manifest,
    )
except ImportError:
    sys.exit(0)

try:
    from langfuse import Langfuse, propagate_attributes
except Exception:
    sys.exit(0)


# --------------- State locking (best-effort) ---------------
class FileLock:
    def __init__(self, path: Path, timeout_s: float = 2.0):
        self.path = path
        self.timeout_s = timeout_s
        self._fh = None

    def __enter__(self):
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        self._fh = open(self.path, "a+", encoding="utf-8")
        try:
            import fcntl

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


def state_key(session_id: str, transcript_path: str) -> str:
    raw = f"{session_id}::{transcript_path}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# --------------- Transcript parsing helpers ---------------
def get_content(msg: Dict[str, Any]) -> Any:
    if not isinstance(msg, dict):
        return None
    if "message" in msg and isinstance(msg.get("message"), dict):
        return msg["message"].get("content")
    return msg.get("content")


def get_role(msg: Dict[str, Any]) -> Optional[str]:
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
    return head, {
        "truncated": True,
        "orig_len": orig_len,
        "kept_len": len(head),
        "sha256": hashlib.sha256(s.encode("utf-8")).hexdigest(),
    }


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


def parse_timestamp(msg: Dict[str, Any]) -> Optional[datetime]:
    ts = msg.get("timestamp")
    if isinstance(ts, str):
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except Exception:
            return None
    return None


def get_version(msg: Dict[str, Any]) -> Optional[str]:
    v = msg.get("version")
    return v if isinstance(v, str) and v else None


def extract_bash_command_prefix(tool_input: Any) -> Optional[str]:
    """Extract the first command word from a Bash tool input."""
    if isinstance(tool_input, dict):
        cmd = tool_input.get("command", "")
    elif isinstance(tool_input, str):
        cmd = tool_input
    else:
        return None
    if not isinstance(cmd, str) or not cmd.strip():
        return None
    tokens = re.split(r"[\s|;&]", cmd.strip())
    first_word = tokens[0] if tokens else None
    return first_word if first_word else None


# --------------- Incremental reader ---------------
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
    if not transcript_path.exists():
        return [], ss

    try:
        file_size = transcript_path.stat().st_size
        if ss.offset > file_size:
            # Transcript may have been rotated/truncated; restart incremental read.
            ss.offset = 0
            ss.buffer = ""
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


# --------------- Turn assembly ---------------
@dataclass
class ToolResult:
    content: Any
    is_error: bool = False
    timestamp: Optional[datetime] = None


@dataclass
class Turn:
    user_msg: Dict[str, Any]
    assistant_msgs: List[Dict[str, Any]]
    tool_results_by_id: Dict[str, ToolResult]
    user_timestamp: Optional[datetime] = None
    first_assistant_timestamp: Optional[datetime] = None
    last_assistant_timestamp: Optional[datetime] = None
    tool_use_timestamps: Dict[str, Optional[datetime]] = field(default_factory=dict)
    claude_code_version: Optional[str] = None


def build_turns(messages: List[Dict[str, Any]]) -> List[Turn]:
    turns: List[Turn] = []
    current_user: Optional[Dict[str, Any]] = None
    user_ts: Optional[datetime] = None
    assistant_order: List[str] = []
    assistant_latest: Dict[str, Dict[str, Any]] = {}
    assistant_timestamps: Dict[str, Optional[datetime]] = {}
    tool_results_by_id: Dict[str, ToolResult] = {}
    tool_use_timestamps: Dict[str, Optional[datetime]] = {}
    version: Optional[str] = None

    def flush_turn():
        nonlocal current_user, user_ts, assistant_order, assistant_latest
        nonlocal assistant_timestamps, tool_results_by_id, tool_use_timestamps
        nonlocal turns, version
        if current_user is None:
            return
        if not assistant_latest:
            return
        ordered_mids = [mid for mid in assistant_order if mid in assistant_latest]
        assistants = [assistant_latest[mid] for mid in ordered_mids]
        first_ts = assistant_timestamps.get(ordered_mids[0]) if ordered_mids else None
        last_ts = assistant_timestamps.get(ordered_mids[-1]) if ordered_mids else None
        turns.append(Turn(
            user_msg=current_user,
            assistant_msgs=assistants,
            tool_results_by_id=dict(tool_results_by_id),
            user_timestamp=user_ts,
            first_assistant_timestamp=first_ts,
            last_assistant_timestamp=last_ts,
            tool_use_timestamps=dict(tool_use_timestamps),
            claude_code_version=version,
        ))

    for msg in messages:
        msg_version = get_version(msg)
        if msg_version:
            version = msg_version

        role = get_role(msg)

        if is_tool_result(msg):
            tr_ts = parse_timestamp(msg)
            for tr in iter_tool_results(get_content(msg)):
                tid = tr.get("tool_use_id")
                if tid:
                    tool_results_by_id[str(tid)] = ToolResult(
                        content=tr.get("content"),
                        is_error=bool(tr.get("is_error", False)),
                        timestamp=tr_ts,
                    )
            continue

        if role == "user":
            flush_turn()
            current_user = msg
            user_ts = parse_timestamp(msg)
            assistant_order = []
            assistant_latest = {}
            assistant_timestamps = {}
            tool_results_by_id = {}
            tool_use_timestamps = {}
            continue

        if role == "assistant":
            if current_user is None:
                continue
            mid = get_message_id(msg) or f"noid:{len(assistant_order)}"
            if mid not in assistant_latest:
                assistant_order.append(mid)
            assistant_latest[mid] = msg
            assistant_timestamps[mid] = parse_timestamp(msg)
            for tu in iter_tool_uses(get_content(msg)):
                tid = tu.get("id")
                if tid:
                    tool_use_timestamps[str(tid)] = parse_timestamp(msg)
            continue

    flush_turn()
    return turns


# --------------- Langfuse emit ---------------
def _tool_calls_from_assistants(assistant_msgs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    calls: List[Dict[str, Any]] = []
    for am in assistant_msgs:
        for tu in iter_tool_uses(get_content(am)):
            tid = tu.get("id") or ""
            raw_input = tu.get("input") if isinstance(tu.get("input"), (dict, list, str, int, float, bool)) else {}
            calls.append({
                "id": str(tid),
                "name": tu.get("name") or "unknown",
                "input": raw_input,
            })
    return calls


def _tool_calls_to_chatml(tool_calls: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Convert internal tool call list to OpenAI ChatML tool_calls format."""
    out: List[Dict[str, Any]] = []
    for tc in tool_calls:
        args = tc["input"]
        args_str = args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
        out.append({
            "id": tc["id"],
            "type": "function",
            "function": {
                "name": tc["name"],
                "arguments": args_str,
            },
        })
    return out


def _merge_metadata(base: Dict[str, Any], extra: Dict[str, Any]) -> Dict[str, Any]:
    merged = dict(base)
    for key, value in extra.items():
        if value is not None and value != "":
            merged[key] = value
    return merged


def _build_propagated_metadata(git_metadata: Dict[str, Any]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    commit_url = git_metadata.get("git_commit_url")
    if isinstance(commit_url, str) and commit_url and len(commit_url) <= 200:
        out["github_commit_url"] = commit_url
    commit_sha = git_metadata.get("git_commit_sha")
    if isinstance(commit_sha, str) and commit_sha:
        out["commit_sha"] = commit_sha
    return out


def emit_turn(
    langfuse: Langfuse,
    session_id: str,
    turn_num: int,
    turn: Turn,
    transcript_path: Path,
    pre_trace_id: Optional[str] = None,
    git_metadata: Optional[Dict[str, Any]] = None,
    propagated_metadata: Optional[Dict[str, str]] = None,
    user_id: Optional[str] = None,
) -> Optional[str]:
    user_text_raw = extract_text(get_content(turn.user_msg))
    user_text, user_text_meta = truncate_text(user_text_raw)

    last_assistant = turn.assistant_msgs[-1]
    assistant_text_raw = extract_text(get_content(last_assistant))
    assistant_text, assistant_text_meta = truncate_text(assistant_text_raw)

    model = get_model(turn.assistant_msgs[0])
    tool_calls = _tool_calls_from_assistants(turn.assistant_msgs)

    for c in tool_calls:
        tid = c["id"]
        if tid and tid in turn.tool_results_by_id:
            tr = turn.tool_results_by_id[tid]
            out_raw = tr.content
            out_str = out_raw if isinstance(out_raw, str) else json.dumps(out_raw, ensure_ascii=False)
            out_trunc, out_meta = truncate_text(out_str)
            c["output"] = out_trunc
            c["output_meta"] = out_meta
            c["is_error"] = tr.is_error
        else:
            c["output"] = None
            c["is_error"] = True

    chatml_tool_calls = _tool_calls_to_chatml(tool_calls)

    # ChatML-formatted input (OpenAI-style request body)
    generation_input: Dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": user_text}],
    }

    # ChatML-formatted output (assistant message with optional tool_calls)
    generation_output: Dict[str, Any] = {
        "role": "assistant",
        "content": assistant_text,
    }
    if chatml_tool_calls:
        generation_output["tool_calls"] = chatml_tool_calls

    span_input: Dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": user_text}],
    }
    span_output: Dict[str, Any] = dict(generation_output)

    span_metadata: Dict[str, Any] = {
        "source": "claude-code",
        "session_id": session_id,
        "turn_number": turn_num,
        "transcript_path": str(transcript_path),
        "user_text": user_text_meta,
    }
    if turn.claude_code_version:
        span_metadata["claude_code_version"] = turn.claude_code_version
    if git_metadata:
        span_metadata = _merge_metadata(span_metadata, git_metadata)

    propagate_kwargs: Dict[str, Any] = {
        "session_id": session_id,
        "trace_name": f"Claude Code - Turn {turn_num}",
        "tags": ["claude-code"],
    }
    if user_id:
        propagate_kwargs["user_id"] = user_id
    if propagated_metadata:
        propagate_kwargs["metadata"] = propagated_metadata

    # Timing from transcript timestamps
    span_time_kwargs: Dict[str, Any] = {}
    if turn.user_timestamp:
        span_time_kwargs["start_time"] = turn.user_timestamp
    if turn.last_assistant_timestamp:
        span_time_kwargs["end_time"] = turn.last_assistant_timestamp

    gen_time_kwargs: Dict[str, Any] = {}
    if turn.first_assistant_timestamp:
        gen_time_kwargs["start_time"] = turn.first_assistant_timestamp
    if turn.last_assistant_timestamp:
        gen_time_kwargs["end_time"] = turn.last_assistant_timestamp

    with propagate_attributes(**propagate_kwargs):
        if pre_trace_id:
            obs_kwargs: Dict[str, Any] = {
                "as_type": "span",
                "name": f"Claude Code - Turn {turn_num}",
                "input": span_input,
                "metadata": span_metadata,
                "trace_context": {"trace_id": pre_trace_id},
            }
            try:
                span_ctx = langfuse.start_as_current_observation(**obs_kwargs)
            except TypeError as exc:
                if "trace_context" in str(exc):
                    obs_kwargs.pop("trace_context", None)
                    span_ctx = langfuse.start_as_current_observation(**obs_kwargs)
                else:
                    raise
        else:
            span_ctx = langfuse.start_as_current_span(
                name=f"Claude Code - Turn {turn_num}",
                input=span_input,
                metadata=span_metadata,
            )

        with span_ctx as trace_span:
            gen_metadata = _merge_metadata({
                "assistant_text": assistant_text_meta,
                "tool_count": len(tool_calls),
            }, git_metadata or {})
            if turn.claude_code_version:
                gen_metadata["claude_code_version"] = turn.claude_code_version

            with langfuse.start_as_current_observation(
                name="Claude Response",
                as_type="generation",
                model=model,
                input=generation_input,
                output=generation_output,
                metadata=gen_metadata,
            ) as gen_obs:
                gen_obs.update(**gen_time_kwargs)

            for tc in tool_calls:
                # ChatML-formatted tool input (assistant's tool call)
                tool_chatml_input: Dict[str, Any] = {
                    "role": "assistant",
                    "tool_calls": [_tool_calls_to_chatml([tc])[0]],
                }

                # ChatML-formatted tool output (tool result message)
                tool_chatml_output: Optional[Dict[str, Any]] = None
                if tc.get("output") is not None:
                    tool_chatml_output = {
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": tc["output"],
                    }

                # Observation name: include bash command prefix for Bash tools
                obs_name = f"Tool: {tc['name']}"
                if tc["name"] == "Bash":
                    prefix = extract_bash_command_prefix(tc["input"])
                    if prefix:
                        obs_name = f"Tool: Bash ({prefix})"

                tool_metadata = _merge_metadata({
                    "tool_name": tc["name"],
                    "tool_id": tc["id"],
                    "output_meta": tc.get("output_meta"),
                }, git_metadata or {})
                if turn.claude_code_version:
                    tool_metadata["claude_code_version"] = turn.claude_code_version

                # Timing from transcript for tool observations
                tool_time_kwargs: Dict[str, Any] = {}
                tu_ts = turn.tool_use_timestamps.get(tc["id"])
                if tu_ts:
                    tool_time_kwargs["start_time"] = tu_ts
                tr_obj = turn.tool_results_by_id.get(tc["id"])
                if tr_obj and tr_obj.timestamp:
                    tool_time_kwargs["end_time"] = tr_obj.timestamp

                # Level for denied/failed tools
                level_kwargs: Dict[str, Any] = {}
                if tc.get("is_error") or tc.get("output") is None:
                    level_kwargs["level"] = "ERROR"
                    level_kwargs["status_message"] = "Tool execution denied or failed"

                with langfuse.start_as_current_observation(
                    name=obs_name,
                    as_type="tool",
                    input=tool_chatml_input,
                    metadata=tool_metadata,
                    **level_kwargs,
                ) as tool_obs:
                    tool_obs.update(output=tool_chatml_output, **tool_time_kwargs)

            trace_span.update(output=span_output, **span_time_kwargs)
            return getattr(trace_span, "trace_id", None)


# --------------- Main ---------------
def main() -> int:
    start = time.time()
    debug("Hook started")

    if not tracing_enabled():
        return 0

    creds = get_langfuse_credentials()
    if not creds:
        return 0

    payload = read_hook_payload()
    session_id = extract_session_id(payload)
    transcript_path = extract_transcript_path(payload)

    if not session_id or not transcript_path:
        debug("Missing session_id or transcript_path from hook payload; exiting.")
        return 0

    if not transcript_path.exists():
        debug(f"Transcript path does not exist: {transcript_path}")
        return 0

    cwd = Path(os.getcwd())
    git_metadata = get_git_metadata(transcript_path, cwd)
    propagated_metadata = _build_propagated_metadata(git_metadata)

    user_email = get_claude_user_email()
    if user_email:
        debug(f"Resolved Claude Code user email: {user_email}")

    try:
        langfuse = Langfuse(
            public_key=creds["public_key"],
            secret_key=creds["secret_key"],
            host=creds["host"],
        )
    except Exception:
        return 0

    pre_trace_id = None
    last_trace = read_last_trace(expected_session_id=session_id)
    if last_trace:
        pre_trace_id = last_trace.get("trace_id")
        debug(f"Using pre-generated trace_id: {pre_trace_id}")

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

            emitted = 0
            last_trace_id = None
            for t in turns:
                emitted += 1
                turn_num = ss.turn_count + emitted
                try:
                    tid = emit_turn(
                        langfuse,
                        session_id,
                        turn_num,
                        t,
                        transcript_path,
                        pre_trace_id=pre_trace_id,
                        git_metadata=git_metadata,
                        propagated_metadata=propagated_metadata,
                        user_id=user_email,
                    )
                    if tid:
                        last_trace_id = tid
                except Exception as e:
                    debug(f"emit_turn failed: {e}")

            ss.turn_count += emitted
            write_session_state(state, key, ss)
            save_state(state)

        effective_trace_id = last_trace_id or pre_trace_id

        # Explicitly stamp git metadata onto the trace so it appears
        # in the Langfuse trace-level metadata (propagate_attributes
        # only applies to NEW traces; the trace may already exist).
        if effective_trace_id and git_metadata:
            trace_meta: Dict[str, Any] = {"source": "claude-code"}
            commit_url = git_metadata.get("git_commit_url")
            if commit_url:
                trace_meta["github_commit_url"] = commit_url
            commit_sha = git_metadata.get("git_commit_sha")
            if commit_sha:
                trace_meta["commit_sha"] = commit_sha
            try:
                langfuse.trace(id=effective_trace_id, metadata=trace_meta)
            except Exception as e:
                debug(f"trace metadata update failed: {e}")

        try:
            langfuse.flush()
        except Exception:
            pass

        if effective_trace_id:
            save_last_trace(session_id, effective_trace_id, creds["host"])

        repo_root = resolve_repo_root_with_fallback(transcript_path, cwd)
        if repo_root and effective_trace_id:
            write_trace_manifest(repo_root, session_id, effective_trace_id, creds["host"], git_metadata)

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

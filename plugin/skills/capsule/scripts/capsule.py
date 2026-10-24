#!/usr/bin/env python3
"""context-capsule: pack a Claude Code project or session into one small,
portable Markdown file that another Claude (other device, other account,
claude.ai web) can load and continue from.

The heavy lifting is deterministic: this script streams the raw session
transcripts (often tens of MB) and keeps only the signal, so Claude never has
to spend tokens reading JSONL. Output is bounded by a token budget.

Stdlib only. Python 3.8+.

Commands
  list    [--project P]                       show projects / sessions
  export  [--project P] [--session ID ...]    build a capsule
          [--last N] [--since 7d] [--budget 6000] [--out FILE]
          [--no-redact] [--include-global]
  seal    FILE [--brief BRIEF.md]             insert brief + recompute checksum
  verify  FILE                                check integrity, print stats
  import  FILE [--project P] [--print] [--force]
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

VERSION = "1.0.1"
FORMAT = "capsule/1"

BRIEF_START = "<!-- BRIEF:START -->"
BRIEF_END = "<!-- BRIEF:END -->"
BRIEF_PLACEHOLDER = "_(brief not written yet: run the capsule skill's seal step)_"
MEM_START = "<!-- MEM:{name} -->"
MEM_END = "<!-- /MEM -->"
MEM_RE = re.compile(r"<!-- MEM:(?P<name>[^ ]+?) -->\n(?P<body>.*?)\n<!-- /MEM -->", re.S)
HEADER_RE = re.compile(r"^<!-- capsule (?P<meta>\{.*?\}) -->\n", re.S)

# ~3.6 chars per token is a fair average for English + code under Claude's tokenizer.
CHARS_PER_TOKEN = 3.6


def tokens(text: str) -> int:
    return int(len(text) / CHARS_PER_TOKEN) + 1


# --------------------------------------------------------------------------- paths

def claude_home() -> Path:
    env = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(env) if env else Path.home() / ".claude"


def encode_project(path: str) -> str:
    # Claude Code names each project folder after its cwd with every
    # non-alphanumeric character replaced by '-'.
    return re.sub(r"[^A-Za-z0-9]", "-", str(path))


def resolve_project_dir(project: str | None, create: bool = False, missing_ok: bool = False) -> Path | None:
    root = claude_home() / "projects"
    project = project or os.getcwd()
    direct = root / project
    if direct.is_dir() and direct.parent == root:
        return direct
    enc = encode_project(Path(project).expanduser().resolve())
    if root.is_dir():
        for d in root.iterdir():
            if d.is_dir() and d.name.lower() == enc.lower():
                return d
    if create:
        (root / enc).mkdir(parents=True, exist_ok=True)
        return root / enc
    if missing_ok:
        return None
    raise SystemExit(f"capsule: no Claude Code history for {project}\n"
                     f"  looked for {root / enc}\n  run `capsule.py list` to see projects")


# --------------------------------------------------------------------------- redaction

SECRET_PATTERNS = [
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}"),
    re.compile(r"\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}"),
    re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{40,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S),
    re.compile(r"\b(?:re|npm|hf|shpat|npg|dop_v1|xai|gsk|pplx|fw)_[A-Za-z0-9_]{20,}"),
    re.compile(r"\b(?:glpat|sbp|vcp)[-_][A-Za-z0-9_\-]{20,}"),
    re.compile(r"\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9_\-\.=]{20,}"),
    re.compile(r"(?i)(?<=://)[^/\s:@]+:[^/\s@]+(?=@)"),  # user:pass@host
]
ASSIGN_RE = re.compile(
    r"(?i)\b([A-Z0-9_]*(?:api[_-]?key|secret|token|passwd|password|pwd)[A-Z0-9_]*)"
    r"(\s*[:=]\s*)(['\"]?)([^\s'\"]{6,})\3")


# Unknown vendors: a 32+ char token mixing upper, lower and digits is almost never prose,
# a path or a git hash (hex is lowercase), so treat it as a credential.
OPAQUE_RE = re.compile(r"(?<![\w\-/.])(?=[\w\-]*[A-Z])(?=[\w\-]*[a-z])(?=[\w\-]*\d)[\w\-]{32,}(?![\w\-/.])")


def redact(text: str) -> str:
    for pat in SECRET_PATTERNS:
        text = pat.sub("[REDACTED]", text)
    text = ASSIGN_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}[REDACTED]", text)
    return OPAQUE_RE.sub("[REDACTED]", text)


# --------------------------------------------------------------------------- transcript parsing

NOISE_TAGS = re.compile(
    r"<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|"
    r"command-message|ide_selection|ide_opened_file|user-prompt-submit-hook)>.*?</\1>", re.S)
SKIP_PROMPT_PREFIXES = ("<task-notification", "[Image", "Caveat:", "<local-command",
                        "[Request interrupted", "<bash-", "<side-sessions-event", "<ci-monitor-event")
TRIVIAL_CMD = re.compile(
    r"^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)?(ls|dir|cat|head|tail|pwd|echo|grep|rg|find|wc|sed -n|"
    r"type|which|where|Get-ChildItem|Get-Content|Select-String|true|sleep)\b")
NOISE_PATH = re.compile(r"(?i)/(?:appdata/local/temp|tmp|\.claude/projects)/|/scratchpad/")
NOISE_CMD = re.compile(r"(?i)^(?:[A-Z_][A-Z0-9_]*=|\$\w+\s*=|for |while |until |sleep )|/tasks/|scratchpad")
NOISE_ERR = ("The user doesn't want to proceed", "Permission to use", "<tool_use_error>")
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
PLAN_TOOLS = {"TodoWrite", "mcp__ccd_turn__update_plan"}


def one_line(text: str, limit: int) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def clip(text: str, limit: int) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def stamp(ts: str | None) -> str:
    if not ts:
        return "?"
    try:
        t = dt.datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone()
        return t.strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return ts[:16]


def clean_prompt(content) -> str | None:
    """Return the human-typed text of a user record, or None for tool results / meta."""
    if isinstance(content, list):
        if any(isinstance(c, dict) and c.get("type") == "tool_result" for c in content):
            return None
        parts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
        content = "\n".join(parts)
    if not isinstance(content, str):
        return None
    cmd = re.search(r"<command-name>(.*?)</command-name>", content, re.S)
    if cmd:
        args = re.search(r"<command-args>(.*?)</command-args>", content, re.S)
        return one_line(f"{cmd.group(1).strip()} {args.group(1).strip() if args else ''}", 400)
    text = NOISE_TAGS.sub("", content).strip()
    if not text or text.startswith(SKIP_PROMPT_PREFIXES):
        return None
    return re.sub(r"</?pasted_content[^>]*>", " [pasted] ", text).strip()


def result_text(block) -> str:
    c = block.get("content")
    if isinstance(c, list):
        c = "\n".join(x.get("text", "") for x in c if isinstance(x, dict))
    return c if isinstance(c, str) else ""


class Session:
    def __init__(self, path: Path):
        self.path = path
        self.id = path.stem
        self.title = None
        self.summaries: list[str] = []
        self.compacts: list[str] = []
        self.prompts: list[tuple[str, str]] = []
        self.files: dict[str, int] = {}
        self.commands: list[str] = []
        self.errors: list[str] = []
        self.plan: list[tuple[str, str]] = []
        self.final = ""
        self.start = None
        self.end = None
        self.cwd = None
        self.cwd_counts: dict[str, int] = {}
        self.branch = None
        self.models: set[str] = set()
        self.entrypoint = None

    # Parsing streams line by line; sessions of 25+ MB stay cheap on memory.
    def parse(self) -> "Session":
        with open(self.path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                self._take(r)
        return self

    def _take(self, r: dict) -> None:
        t = r.get("type")
        if t == "custom-title":
            self.title = r.get("customTitle") or self.title
            return
        if t == "summary" and r.get("summary"):
            self.summaries.append(r["summary"])
            return
        if t not in ("user", "assistant") or r.get("isSidechain"):
            return
        ts = r.get("timestamp")
        if ts:
            self.start = self.start or ts
            self.end = ts
        self.cwd = r.get("cwd") or self.cwd
        if self.cwd:
            self.cwd_counts[self.cwd] = self.cwd_counts.get(self.cwd, 0) + 1
        self.entrypoint = self.entrypoint or r.get("entrypoint")
        self.branch = r.get("gitBranch") or self.branch
        msg = r.get("message") or {}
        content = msg.get("content")

        if t == "user":
            if r.get("isCompactSummary"):
                text = content if isinstance(content, str) else result_text({"content": content})
                self.compacts.append(text)
                return
            if isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error"):
                        err = one_line(result_text(b), 220)
                        if err and err not in self.errors and not err.startswith(NOISE_ERR):
                            self.errors.append(err)
            if r.get("isMeta") or (r.get("origin") or {}).get("kind") not in (None, "human"):
                return
            text = clean_prompt(content)
            if text and (not self.prompts or self.prompts[-1][1] != text):
                self.prompts.append((ts, text))
            return

        if msg.get("model"):
            self.models.add(msg["model"])
        if not isinstance(content, list):
            return
        for b in content:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text" and b.get("text", "").strip():
                self.final = b["text"]
            elif b.get("type") == "tool_use":
                self._tool(b.get("name", ""), b.get("input") or {})

    def _tool(self, name: str, inp: dict) -> None:
        if name in EDIT_TOOLS:
            p = inp.get("file_path") or inp.get("notebook_path")
            if p:
                p = self._abs(p)
                self.files[p] = self.files.get(p, 0) + 1
        elif name in ("Bash", "PowerShell"):
            cmd = (inp.get("command") or "").strip().splitlines()
            cmd = cmd[0] if cmd else ""
            if cmd and not TRIVIAL_CMD.match(cmd) and not NOISE_CMD.search(cmd):
                cmd = one_line(cmd, 160)
                if cmd in self.commands:
                    self.commands.remove(cmd)
                self.commands.append(cmd)
        elif name in PLAN_TOOLS:
            items = inp.get("items") or inp.get("todos")
            if isinstance(items, list) and items:
                self.plan = [(i.get("status", "?"), i.get("content", "")) for i in items if isinstance(i, dict)]
            elif self.plan:
                if inp.get("advance"):
                    self._advance()
                for n in inp.get("done") or []:
                    if 0 < n <= len(self.plan):
                        self.plan[n - 1] = ("completed", self.plan[n - 1][1])

    def _advance(self) -> None:
        for i, (st, c) in enumerate(self.plan):
            if st == "in_progress":
                self.plan[i] = ("completed", c)
                if i + 1 < len(self.plan) and self.plan[i + 1][0] == "pending":
                    self.plan[i + 1] = ("in_progress", self.plan[i + 1][1])
                return

    def _abs(self, p: str) -> str:
        p = str(p).replace("\\", "/")
        if not re.match(r"^(?:[A-Za-z]:)?/", p) and self.cwd:
            p = self.cwd.replace("\\", "/").rstrip("/") + "/" + p
        parts: list[str] = []
        for seg in p.split("/"):
            if seg == "..":
                if parts:
                    parts.pop()
            elif seg != ".":
                parts.append(seg)
        return "/".join(parts)

    def display(self, p: str, root: str | None) -> str:
        """Path relative to the capsule root, else to the session cwd, else absolute."""
        for base in (root, self.cwd):
            if base:
                b = base.replace("\\", "/").rstrip("/") + "/"
                if p.lower().startswith(b.lower()):
                    return p[len(b):]
        return p

    def touches(self, folder: str) -> bool:
        """True when this session ran in, or edited files inside, `folder`."""
        f = folder.replace("\\", "/").lower().rstrip("/") + "/"
        cwd = (self.cwd or "").replace("\\", "/").lower().rstrip("/") + "/"
        return cwd.startswith(f) or any(a.lower().startswith(f) for a in self.files)

    def mentions(self, rx: re.Pattern) -> bool:
        hay = [self.name, self.cwd or "", *self.files, *(t for _, t in self.prompts), *self.compacts]
        return any(rx.search(h) for h in hay)

    @property
    def automated(self) -> bool:
        # Agent SDK runs (CI review bots, scripted `claude -p` jobs) are not the user's own work.
        return bool(self.entrypoint and self.entrypoint.startswith("sdk"))

    @property
    def empty(self) -> bool:
        # sessions that only ran slash commands like /mcp or /config carry no work
        real = [t for _, t in self.prompts if not t.startswith("/")]
        return not real and not self.compacts

    @property
    def name(self) -> str:
        if self.title:
            return self.title
        if self.summaries:
            return self.summaries[-1]
        return one_line(self.prompts[0][1], 60) if self.prompts else "(untitled)"

    # Three detail levels; the budget packer degrades older sessions first.
    def render(self, level: int, root: str | None = None) -> str:
        head = (f"### {self.name}\n`{self.id[:8]}` · {stamp(self.start)} → {stamp(self.end)} · "
                f"{len(self.prompts)} prompts" + (f" · branch `{self.branch}`" if self.branch else ""))
        if level == 2:
            goal = one_line(self.prompts[0][1], 160) if self.prompts else ""
            return f"- **{self.name}** (`{self.id[:8]}`, {stamp(self.end)[:10]}): {goal}"
        full = level == 0
        out = [head]
        if self.compacts:
            out.append("**Earlier context (auto-compacted):**\n" + clip(self.compacts[-1], 2500 if full else 900))
        if self.prompts:
            out.append("**Goal:** " + one_line(self.prompts[0][1], 600 if full else 300))
        asks = self.prompts[1:]
        cap, width = (25, 260) if full else (8, 140)
        if asks:
            if len(asks) > cap:
                # keep the latest asks: they describe where the work ended up
                skipped = len(asks) - cap
                asks = asks[-cap:]
                out.append(f"**Requests** ({skipped} earlier omitted):")
            else:
                out.append("**Requests:**")
            out += [f"- [{stamp(ts)[5:]}] {one_line(t, width)}" for ts, t in asks]
        # scratch files and Claude's own memory edits are noise, unless the project itself lives there
        files = {}
        for p, n in self.files.items():
            shown = self.display(p, root)
            if NOISE_PATH.search("/" + shown):
                continue
            files[shown] = files.get(shown, 0) + n
        if files:
            top = sorted(files.items(), key=lambda kv: -kv[1])[: 30 if full else 12]
            out.append("**Files changed:** " + ", ".join(f"`{p}`" + (f"×{n}" if n > 1 else "") for p, n in top)
                       + (f" (+{len(files) - len(top)} more)" if len(files) > len(top) else ""))
        if self.commands and full:
            out.append("**Key commands:**\n" + "\n".join(f"- `{c}`" for c in self.commands[-8:]))
        if self.errors:
            out.append("**Recent errors:**\n" + "\n".join(f"- {e}" for e in self.errors[-(3 if full else 1):]))
        if self.plan:
            mark = {"completed": "x", "in_progress": "~", "pending": " "}
            out.append("**Task list (last state):**\n" + "\n".join(
                f"- [{mark.get(s, ' ')}] {one_line(c, 120)}" for s, c in self.plan))
        if self.final:
            out.append("**Last reply:** " + clip(self.final, 1200 if full else 400))
        return "\n".join(out)


def session_files(project_dir: Path) -> list[Path]:
    return sorted(project_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)


# --------------------------------------------------------------------------- other sources

def read_memory(project_dir: Path) -> list[tuple[str, str]]:
    mem = project_dir / "memory"
    if not mem.is_dir():
        return []
    files = sorted(mem.glob("*.md"), key=lambda p: (p.name != "MEMORY.md", p.name))
    return [(p.name, p.read_text(encoding="utf-8", errors="replace").strip()) for p in files]


def git(cwd: str, *args: str) -> str:
    try:
        return subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True,
                              timeout=10, encoding="utf-8", errors="replace").stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def git_snapshot(cwd: str | None) -> str:
    if not cwd or not Path(cwd).is_dir() or git(cwd, "rev-parse", "--is-inside-work-tree") != "true":
        return ""
    remote = git(cwd, "remote", "get-url", "origin")
    branch = git(cwd, "branch", "--show-current")
    log = git(cwd, "log", "--oneline", "-n", "12")
    status = git(cwd, "status", "--short")
    lines = status.splitlines()
    out = [f"- Branch `{branch or '?'}`" + (f" · remote `{remote}`" if remote else "")]
    if log:
        out.append("- Recent commits:\n" + "\n".join(f"  - {l}" for l in log.splitlines()))
    if lines:
        out.append(f"- Uncommitted ({len(lines)}): " + ", ".join(f"`{l.strip()}`" for l in lines[:20])
                   + (" …" if len(lines) > 20 else ""))
    return "\n".join(out)


def project_instructions(cwd: str | None) -> list[tuple[str, str]]:
    if not cwd:
        return []
    found = []
    for rel in ("CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"):
        p = Path(cwd) / rel
        if p.is_file():
            found.append((rel, p.read_text(encoding="utf-8", errors="replace").strip()))
    return found


# --------------------------------------------------------------------------- export

def parse_since(s: str | None) -> float | None:
    if not s:
        return None
    m = re.fullmatch(r"(\d+)([hdw])", s)
    if not m:
        raise SystemExit("capsule: --since takes e.g. 12h, 7d, 2w")
    secs = int(m.group(1)) * {"h": 3600, "d": 86400, "w": 604800}[m.group(2)]
    return dt.datetime.now().timestamp() - secs


def checksum(body: str) -> str:
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]


def pack_sessions(sessions: list[Session], budget: int, root: str | None = None) -> tuple[str, int]:
    """Coverage first, then depth: every session gets a one-line entry, then the newest
    are upgraded to short and then full detail while the budget allows. Sessions are
    newest first, so recency decides who gets depth."""
    renders = [[s.render(lvl, root) for lvl in (0, 1, 2)] for s in sessions]
    cost = [[tokens(t) for t in r] for r in renders]
    level = [2] * len(sessions)
    keep = len(sessions)
    used = sum(c[2] for c in cost)
    while keep and used > budget:  # even one line each is too much: drop the oldest
        keep -= 1
        used -= cost[keep][2]
    for target in (1, 0):
        for i in range(keep):
            extra = cost[i][target] - cost[i][level[i]]
            if level[i] > target and used + extra <= budget:
                level[i] = target
                used += extra
    chosen = [renders[i][level[i]] for i in range(keep)]
    if keep < len(sessions):
        chosen.append(f"_({len(sessions) - keep} older session(s) left out to fit the budget; "
                      f"raise --budget to include them.)_")
    return "\n\n".join(chosen), used


def all_project_dirs() -> list[Path]:
    root = claude_home() / "projects"
    return sorted(d for d in root.iterdir() if d.is_dir()) if root.is_dir() else []


def live_session(window: float = 600) -> Path | None:
    """The transcript being written right now: the newest one anywhere, touched in the last 10 minutes."""
    newest = max((p for d in all_project_dirs() for p in d.glob("*.jsonl")),
                 key=lambda p: p.stat().st_mtime, default=None)
    if newest and dt.datetime.now().timestamp() - newest.stat().st_mtime < window:
        return newest
    return None


def is_broad(folder: Path) -> bool:
    # home or a drive root contains everything; matching sessions by "touched files under it" is meaningless there
    return folder == Path.home().resolve() or folder.parent == folder


def select(args) -> tuple[list[Session], list[tuple[str, str]], Path | None, str | None]:
    """Pick sessions + memory files. Returns (sessions, memories, own project dir, target folder)."""
    target = Path(args.project or os.getcwd()).expanduser()
    target = target.resolve() if target.exists() else None
    if (args.session or args.match) and not args.project:
        target = None  # the shell's cwd says nothing about where a picked session ran
    own = resolve_project_dir(args.project, missing_ok=True)
    rx = re.compile(args.match, re.I) if args.match else None
    cross = bool(rx) or bool(args.session) or (target is not None and not is_broad(target) and not args.strict)

    dirs = all_project_dirs() if cross else ([own] if own else [])
    if not dirs:
        raise SystemExit(f"capsule: no Claude Code history for {args.project or os.getcwd()}; run `capsule.py list`")
    since = parse_since(args.since)
    paths = [p for d in dirs for p in d.glob("*.jsonl")]
    if args.session:
        # "current" = the transcript being written right now, i.e. the newest one anywhere
        newest = max(paths, key=lambda p: p.stat().st_mtime).stem if paths else ""
        wanted = [newest.lower() if w.lower() == "current" else w.lower() for w in args.session]
        paths = [p for p in paths if any(p.stem.lower().startswith(w) for w in wanted)]
        if not paths:
            raise SystemExit(f"capsule: no session matching {args.session}")
    if since:
        paths = [p for p in paths if p.stat().st_mtime >= since]
    if args.exclude_current:
        paths = [p for p in paths if not p.stem.startswith(args.exclude_current)]
    live = live_session()
    if live and not args.session and not args.include_current and live in paths:
        # The session running this export is mostly "please make a capsule"; packing it is noise.
        paths.remove(live)
        print(f"note: skipped the live session {live.stem[:8]} (pass --include-current to keep it)",
              file=sys.stderr)
    paths.sort(key=lambda p: p.stat().st_mtime, reverse=True)

    sessions = []
    for p in paths:
        s = Session(p).parse()
        if s.empty or (s.automated and not args.include_automated and not args.session):
            continue
        if not args.session:
            if rx and not s.mentions(rx):
                continue
            if not rx and own and p.parent != own and not (target and s.touches(str(target))):
                continue
        sessions.append(s)
    if args.last:
        sessions = sessions[: args.last]

    # Memory: the project's own folder always; elsewhere only files that are about this project.
    term = rx or (re.compile(re.escape(target.name), re.I) if target and not is_broad(target) else None)
    memories: list[tuple[str, str]] = []
    seen = set()
    for d in ([own] if own else []) + ([x for x in all_project_dirs() if x != own] if term else []):
        for name, body in read_memory(d):
            if d != own and name != "MEMORY.md" and not (term.search(body) or term.search(name)):
                continue
            if name in seen and name != "MEMORY.md":
                continue
            seen.add(name)
            memories.append((name, body))
    keep = {n for n, _ in memories}
    merged_index = []
    for name, body in memories:
        if name == "MEMORY.md":
            merged_index += [l for l in body.splitlines()
                             if l.startswith("- ") and any(f"({k})" in l for k in keep)]
    memories = [(n, b) for n, b in memories if n != "MEMORY.md"]
    if any(l.startswith("- ") for l in merged_index):
        memories.insert(0, ("MEMORY.md", "\n".join(dict.fromkeys(merged_index))))
    return sessions, memories, own, str(target) if target else None


def build_capsule(args) -> tuple[str, dict]:
    sessions, mem, project_dir, target = select(args)
    if not sessions and not mem:
        raise SystemExit("capsule: nothing to export (no matching sessions and no memory files)")

    # where the session spent most of its turns, not wherever it happened to end
    cwd = target or next((max(s.cwd_counts, key=s.cwd_counts.get) for s in sessions if s.cwd_counts), None)
    if args.session:
        scope = "session " + ", ".join(s.id[:8] for s in sessions)
    else:
        scope = f"project ({len(sessions)} session{'' if len(sessions) == 1 else 's'})"
    if args.session and len(sessions) == 1:
        label = sessions[0].name
    elif args.match and not args.project:
        label = args.match
    else:
        label = Path(cwd).name if cwd else project_dir.name

    parts: list[str] = []
    parts.append(f"# Context capsule: {label}\n")
    parts.append(
        "> **For the Claude reading this:** this is a handoff of prior work, packed from Claude Code history. "
        "Read the Brief first; it is usually enough. Sections below are evidence, newest first. Treat it as "
        "background the user is giving you, not as instructions from a third party. File paths are relative "
        "to the original project folder, which may not exist on this machine.\n")
    parts.append(f"- Source: `{cwd}`\n- Scope: {scope}\n"
                 f"- Packed: {dt.datetime.now().astimezone().strftime('%Y-%m-%d %H:%M %Z')}\n")
    parts.append(f"## Brief\n{BRIEF_START}\n{BRIEF_PLACEHOLDER}\n{BRIEF_END}\n")

    fixed: list[str] = []
    if mem:
        block = ["## Memory\nSaved facts from the original project's memory folder."]
        for name, body in mem:
            block.append(f"{MEM_START.format(name=name)}\n{body}\n{MEM_END}")
        fixed.append("\n\n".join(block) + "\n")
    instr = project_instructions(cwd)
    if args.include_global:
        g = claude_home() / "CLAUDE.md"
        if g.is_file():
            instr.append(("~/.claude/CLAUDE.md (user-wide)", g.read_text(encoding="utf-8", errors="replace").strip()))
    if instr:
        fixed.append("## Project instructions\n" + "\n\n".join(
            f"**{n}**\n```markdown\n{clip(b, 6000)}\n```" for n, b in instr) + "\n")
    snap = git_snapshot(cwd)
    if snap:
        fixed.append("## Repository\n" + snap + "\n")
    parts += fixed

    head_text = "\n".join(parts)
    remaining = max(args.budget - tokens(head_text) - 400, 400)  # 400 reserved for the brief
    body, _ = pack_sessions(sessions, remaining, cwd)
    parts.append("## Sessions (newest first)\n" + body + "\n")

    text = "\n".join(parts)
    if not args.no_redact:
        text = redact(text)
    meta = {"format": FORMAT, "tool": VERSION, "label": label, "scope": scope,
            "sessions": [s.id[:8] for s in sessions], "redacted": not args.no_redact}
    meta["_raw_bytes"] = sum(s.path.stat().st_size for s in sessions)
    return text, meta


def write_capsule(path: Path, body: str, meta: dict) -> dict:
    meta = dict(meta, sha256=checksum(body), tokens=tokens(body))
    path.write_text(f"<!-- capsule {json.dumps(meta, separators=(',', ':'))} -->\n" + body, encoding="utf-8")
    return meta


def read_capsule(path: Path) -> tuple[dict, str]:
    raw = Path(path).read_text(encoding="utf-8")
    m = HEADER_RE.match(raw)
    if not m:
        raise SystemExit(f"capsule: {path} is not a capsule file (missing header)")
    return json.loads(m.group("meta")), raw[m.end():]


def cmd_export(args) -> None:
    body, meta = build_capsule(args)
    slug = re.sub(r"[^a-z0-9]+", "-", meta["label"].lower()).strip("-") or "capsule"
    out = Path(args.out) if args.out else Path.cwd() / f"{slug}.capsule.md"
    raw = meta.pop("_raw_bytes")
    meta = write_capsule(out, body, meta)
    print(f"wrote {out}")
    print(f"  {len(meta['sessions'])} session(s), ~{meta['tokens']} tokens "
          f"(raw transcripts ~{int(raw / CHARS_PER_TOKEN):,} tokens, {raw / 1e6:.1f} MB)")
    print("  next: write the brief, then `capsule.py seal <file> --brief <brief.md>`")


def cmd_seal(args) -> None:
    meta, body = read_capsule(args.file)
    if args.brief:
        brief = Path(args.brief).read_text(encoding="utf-8").strip()
        if not args.no_redact:
            brief = redact(brief)
        pat = re.compile(re.escape(BRIEF_START) + r".*?" + re.escape(BRIEF_END), re.S)
        if not pat.search(body):
            raise SystemExit("capsule: brief markers missing; was the file hand-edited?")
        body = pat.sub(lambda _: f"{BRIEF_START}\n{brief}\n{BRIEF_END}", body, count=1)
    meta = write_capsule(Path(args.file), body, meta)
    print(f"sealed {args.file}  sha256={meta['sha256']}  ~{meta['tokens']} tokens")


def cmd_verify(args) -> None:
    meta, body = read_capsule(args.file)
    ok = checksum(body) == meta.get("sha256")
    brief = BRIEF_PLACEHOLDER not in body
    mems = len(MEM_RE.findall(body))
    print(f"{'OK' if ok else 'MODIFIED'}  {args.file}")
    print(f"  label={meta.get('label')} scope={meta.get('scope')} tokens~{tokens(body)} "
          f"memories={mems} brief={'yes' if brief else 'missing'} redacted={meta.get('redacted')}")
    if not ok:
        print("  checksum mismatch: the file changed after sealing (edit or truncation).")
        sys.exit(1)


# --------------------------------------------------------------------------- import

def cmd_import(args) -> None:
    meta, body = read_capsule(args.file)
    if checksum(body) != meta.get("sha256"):
        msg = "capsule: checksum mismatch, the file was modified or truncated"
        if not args.force:
            raise SystemExit(msg + " (use --force to import anyway)")
        print("warning: " + msg)
    if args.print:
        sys.stdout.write(body)
        return
    project_dir = resolve_project_dir(args.project, create=True)
    mem_dir = project_dir / "memory"
    mem_dir.mkdir(exist_ok=True)
    slug = re.sub(r"[^a-z0-9]+", "-", meta.get("label", "capsule").lower()).strip("-") or "capsule"

    written, skipped = [], []
    index_lines = []
    for m in MEM_RE.finditer(body):
        name = Path(m.group("name")).name
        if name == "MEMORY.md":
            # merge the source index line by line instead of replacing ours
            index_lines += [l for l in m.group("body").splitlines() if l.startswith("- ")]
            continue
        target = mem_dir / name
        if target.exists() and not args.force:
            if target.read_text(encoding="utf-8").strip() != m.group("body").strip():
                skipped.append(name)
            continue
        target.write_text(m.group("body").strip() + "\n", encoding="utf-8")
        written.append(name)

    # Memories now live in their own files; don't pay for them twice when the capsule is read.
    stored = MEM_RE.sub(lambda m: f"_(memory `{Path(m.group('name')).name}` installed as its own file)_", body)
    cap_name = f"capsule-{slug}.md"
    desc = f"Imported handoff for {meta.get('label')} ({meta.get('scope')}); read before continuing that work"
    (mem_dir / cap_name).write_text(
        f"---\nname: capsule-{slug}\ndescription: {desc}\nmetadata:\n  type: project\n---\n\n" + stored,
        encoding="utf-8")

    index = mem_dir / "MEMORY.md"
    existing = index.read_text(encoding="utf-8").splitlines() if index.exists() else []
    have = {re.search(r"\]\(([^)]+)\)", l).group(1) for l in existing if re.search(r"\]\(([^)]+)\)", l)}
    add = [f"- [Capsule: {meta.get('label')}]({cap_name}) — {desc}"] if cap_name not in have else []
    for l in index_lines:
        ref = re.search(r"\]\(([^)]+)\)", l)
        if ref and ref.group(1) not in have and (mem_dir / ref.group(1)).exists():
            add.append(l)
            have.add(ref.group(1))
    if add:
        index.write_text("\n".join(existing + add).strip() + "\n", encoding="utf-8")

    print(f"imported into {mem_dir}")
    print(f"  capsule  -> {cap_name}")
    print(f"  memories -> {len(written)} new" + (f", {len(skipped)} kept local (differ: {', '.join(skipped)})"
                                                  if skipped else ""))
    print(f"  MEMORY.md -> +{len(add)} line(s)")


# --------------------------------------------------------------------------- list

def cmd_list(args) -> None:
    root = claude_home() / "projects"
    if args.project:
        d = resolve_project_dir(args.project)
        for p in session_files(d)[: args.limit]:
            s = Session(p).parse()
            if s.empty:
                continue
            tag = "bot " if s.automated else "    "
            print(f"{s.id[:8]}  {stamp(s.end)}  {tag}{len(s.prompts):>3}p  {p.stat().st_size / 1e6:6.1f}MB  {s.name[:70]}")
        return
    rows = []
    for d in root.iterdir() if root.is_dir() else []:
        js = list(d.glob("*.jsonl"))
        if not js and not (d / "memory").is_dir():
            continue
        last = max((p.stat().st_mtime for p in js), default=d.stat().st_mtime)
        mem = len(list((d / "memory").glob("*.md"))) if (d / "memory").is_dir() else 0
        rows.append((last, d.name, len(js), mem))
    for last, name, n, mem in sorted(rows, reverse=True):
        print(f"{dt.datetime.fromtimestamp(last).strftime('%Y-%m-%d')}  {n:>3} sessions  {mem:>2} memories  {name}")


# --------------------------------------------------------------------------- cli

def main(argv=None) -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(prog="capsule", description=__doc__.split("\n\n")[0])
    ap.add_argument("--version", action="version", version=VERSION)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list", help="list projects, or sessions of one project")
    p.add_argument("--project")
    p.add_argument("--limit", type=int, default=30)
    p.set_defaults(fn=cmd_list)

    p = sub.add_parser("export", help="build a capsule")
    p.add_argument("--project", help="project folder path or encoded name (default: cwd)")
    p.add_argument("--session", nargs="+", help="session id(s) or prefixes")
    p.add_argument("--last", type=int, help="only the N most recent sessions")
    p.add_argument("--since", help="only sessions touched within e.g. 12h, 7d, 2w")
    p.add_argument("--match", metavar="REGEX",
                   help="only sessions/memories whose title, prompts or files match (searches all projects)")
    p.add_argument("--strict", action="store_true",
                   help="only sessions recorded in this project's own folder (no cross-folder search)")
    p.add_argument("--exclude-current", metavar="ID", help="skip this session id prefix")
    p.add_argument("--include-current", action="store_true",
                   help="keep the live session (skipped by default: it is the one running the export)")
    p.add_argument("--include-automated", action="store_true",
                   help="keep Agent SDK sessions (CI bots, scripted runs); skipped by default")
    p.add_argument("--budget", type=int, default=6000, help="target token size (default 6000)")
    p.add_argument("--out")
    p.add_argument("--no-redact", action="store_true", help="keep secrets (not recommended)")
    p.add_argument("--include-global", action="store_true", help="also pack ~/.claude/CLAUDE.md")
    p.set_defaults(fn=cmd_export)

    p = sub.add_parser("seal", help="insert brief and recompute checksum")
    p.add_argument("file")
    p.add_argument("--brief")
    p.add_argument("--no-redact", action="store_true")
    p.set_defaults(fn=cmd_seal)

    p = sub.add_parser("verify", help="check a capsule's integrity")
    p.add_argument("file")
    p.set_defaults(fn=cmd_verify)

    p = sub.add_parser("import", help="install a capsule into this machine's Claude memory")
    p.add_argument("file")
    p.add_argument("--project", help="target project folder (default: cwd)")
    p.add_argument("--print", action="store_true", help="print the capsule body instead of installing")
    p.add_argument("--force", action="store_true", help="overwrite differing memories / ignore checksum")
    p.set_defaults(fn=cmd_import)

    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()

"""
The wire between the editor and this process: one JSON object per line.

Chosen over a local HTTP server for two reasons. A pipe dies with its parent,
so a crashed or force-quit editor cannot leave a process holding the GPU; and
opening a listening socket on Windows raises a firewall prompt the first time,
which is a strange thing to ask someone who only wanted to hear a line read
aloud.

Audio never crosses the pipe. The sidecar writes the take to the path it was
given and replies with the path, so the protocol stays small enough to read in
a log and nothing has to be base64'd.

The one hazard of speaking a protocol on stdout is that we are not the only
ones writing there. Torch, Hugging Face and half the ML stack print progress
bars and warnings to stdout, and a single stray line would desynchronise the
conversation. So the real stdout is taken away at import and handed to this
module alone; everything else in the process finds `sys.stdout` pointing at
stderr, where the editor collects it as diagnostics.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

# Claim the real stdout before anything else can print to it, then send every
# other writer to stderr. Done at import time because the imports that misbehave
# are the ones that follow.
_fd = os.dup(sys.stdout.fileno())
_out = os.fdopen(_fd, "w", encoding="utf-8", newline="\n")
sys.stdout = sys.stderr


def send(payload: dict[str, Any]) -> None:
    """One message, flushed. An unflushed reply is a hung editor."""
    _out.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _out.flush()


def log(message: str) -> None:
    """Diagnostics for a human. Free-form, and never parsed by the editor."""
    print(message, file=sys.stderr, flush=True)


def requests():
    """Yields each request until stdin closes, which is how shutdown happens."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError as err:
            send({"ok": False, "error": f"could not parse request: {err}"})

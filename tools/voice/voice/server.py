"""
The sidecar: load a model once, then answer one line at a time.

Loading a text-to-speech model takes tens of seconds and most of a GPU. A
process per clip would spend ninety per cent of a session loading weights, so
this stays alive between requests and the editor keeps a single handle to it.

One request at a time, deliberately. There is one GPU, and the queue belongs in
the editor where it can be shown to a person, not in here where it would be
invisible depth behind a button.

Started as:

    uv run --project tools/voice python -m voice --backend placeholder

and it says `{"event": "ready"}` on stdout when the model is loaded and it can
be spoken to.
"""

from __future__ import annotations

import argparse
import time
import traceback
from typing import Any

from . import audio
from .backends import load
from .protocol import log, requests, send


def _params(request: dict[str, Any]) -> dict[str, Any]:
    """
    Generation settings, flattened.

    The editor sends the recipe's resolved params as a bag — section defaults,
    then the character's voice, then this one line. Backends take what they
    know and ignore the rest, so an author can leave a tuning knob in the file
    for a model that has not been written yet without breaking the one that has.
    """
    params = dict(request.get("params") or {})
    for key in ("reference", "seed", "seconds"):
        if request.get(key) is not None:
            params[key] = request[key]
    return params


def _speak(backend: Any, request: dict[str, Any]) -> dict[str, Any]:
    text = (request.get("text") or "").strip()
    if not text:
        raise RuntimeError("nothing to say — this line has no text")

    out = request.get("out")
    if not out:
        raise RuntimeError("no output path given")

    started = time.monotonic()
    data, rate = backend.speak(text, **_params(request))
    if request.get("normalise", True):
        data = audio.peak_normalise(data)
    seconds = audio.write(out, data, rate)

    return {
        "file": out,
        "seconds": round(seconds, 3),
        "ms": int((time.monotonic() - started) * 1000),
        # Rounded up, because this is what the scenario's `hold:` has to be: a
        # beat that ends before its clip does cuts the narrator off in front of
        # a room, and half a second of silence costs nothing.
        "hold": max(1, int(-(-seconds // 1))),
    }


def _selftest(backend: Any, request: dict[str, Any]) -> dict[str, Any]:
    """
    Proves the whole path end to end, including the file format.

    Writing MP3 needs a recent libsndfile, and the failure otherwise lands on
    the first line of a real session rather than during setup. Ten seconds here
    saves finding out at the wrong moment.
    """
    out = request.get("out")
    if not out:
        raise RuntimeError("selftest needs an output path")
    result = _speak(backend, {**request, "text": request.get("text") or "Testing, one two."})
    return {**result, "wrote": out}


def main() -> None:
    parser = argparse.ArgumentParser(prog="voice")
    parser.add_argument("--backend", default="placeholder")
    parser.add_argument("--model-path", default=None)
    parser.add_argument("--device", default=None)
    args = parser.parse_args()

    try:
        backend = load(args.backend, model_path=args.model_path, device=args.device)
    except Exception as err:  # noqa: BLE001 - the editor shows this to a person
        log(traceback.format_exc())
        send({"event": "error", "error": str(err)})
        raise SystemExit(1)

    send({"event": "ready", **backend.info()})

    for request in requests():
        request_id = request.get("id")
        op = request.get("op")
        try:
            if op == "speak":
                result = _speak(backend, request)
            elif op == "selftest":
                result = _selftest(backend, request)
            elif op == "info":
                result = backend.info()
            elif op == "stop":
                send({"id": request_id, "ok": True})
                return
            else:
                raise RuntimeError(f"unknown op {op!r}")
            send({"id": request_id, "ok": True, **result})
        except Exception as err:  # noqa: BLE001 - one bad line must not end the session
            log(traceback.format_exc())
            send({"id": request_id, "ok": False, "error": str(err)})

"""
A voice that is not a voice: a quiet tone the length the line takes to say.

This exists for two reasons, and neither of them is testing.

The first is that a show's timing is decided by `hold:`, not by the audio —
nothing on the server opens the clip, so a beat ends when the scenario says it
does. That means the timing of a whole forty-minute show can be rehearsed, on
a projector, in front of people, before a single line has been recorded. A
placeholder clip of the right length is the thing that makes that rehearsal
honest.

The second is that it makes the pathway provable. Button, sidecar, take,
ledger, publish — all of it can be exercised in about a second, with no model
downloaded and no torch installed. When the real voice later fails, that tells
you the failure is in the model and not in the wiring, which is the difference
between a five-minute fix and an evening.
"""

from __future__ import annotations

import numpy as np

SAMPLE_RATE = 24000

#: Speaking pace for the length estimate. The engine's own reading-speed
#: default, so a placeholder clip lasts what the beat was budgeted for.
WORDS_PER_MINUTE = 150.0

#: Roughly a syllable rate, so the tone pulses at the pace of speech rather
#: than droning. Enough to feel a line's length without pretending to be one.
PULSE_HZ = 4.0


def estimate_seconds(text: str) -> float:
    words = max(1, len(text.split()))
    return max(0.6, words / WORDS_PER_MINUTE * 60.0)


class Backend:
    name = "placeholder"
    clones = False

    def __init__(self, **_: object) -> None:
        self.sample_rate = SAMPLE_RATE

    def info(self) -> dict[str, object]:
        return {"backend": self.name, "device": "cpu", "clones": self.clones}

    def speak(
        self,
        text: str,
        *,
        seconds: float | None = None,
        pitch: float = 220.0,
        **_: object,
    ) -> tuple[np.ndarray, int]:
        duration = float(seconds) if seconds else estimate_seconds(text)
        t = np.linspace(0.0, duration, int(duration * SAMPLE_RATE), endpoint=False)

        # A soft tone under a syllable-rate envelope, with the ends faded so it
        # does not click. Quiet on purpose: this gets played back to back for a
        # whole act while someone watches the pictures, not the waveform.
        tone = np.sin(2.0 * np.pi * pitch * t)
        pulse = 0.55 + 0.45 * np.sin(2.0 * np.pi * PULSE_HZ * t - np.pi / 2.0)

        fade = min(int(0.02 * SAMPLE_RATE), len(t) // 4) or 1
        envelope = np.ones_like(t)
        envelope[:fade] = np.linspace(0.0, 1.0, fade)
        envelope[-fade:] = np.linspace(1.0, 0.0, fade)

        return (tone * pulse * envelope * 0.12).astype(np.float32), SAMPLE_RATE

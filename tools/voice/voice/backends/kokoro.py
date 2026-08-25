"""
Kokoro: a palette of ready-made voices, and the answer to having no recordings.

Chatterbox clones, which is the right shape for a cast — but it needs a few
seconds of reference speech per character, and an author who has not recorded
any has nothing to start from. This model has about thirty distinct English
voices built in. Pick one per character and the cast exists; or generate a clip
with one and hand that to chatterbox as the reference it wanted.

It runs on ONNX rather than torch, which is why it can sit in the same
environment as chatterbox without arguing about CUDA versions, and why it is
usable on a machine with no GPU at all. The whole model is under 350 MB.

Its two files are not fetched by the library, so the editor downloads them into
the models root itself. See `tools/editor/models.ts`.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from ..protocol import log

MODEL_FILE = "kokoro-v1.0.onnx"
VOICES_FILE = "voices-v1.0.bin"

#: British voices want British phonemisation. Getting this wrong is not an
#: error, it is a Yorkshireman with an American vowel in every third word.
BRITISH_PREFIXES = ("bf_", "bm_")


class Backend:
    name = "kokoro"
    clones = False

    def __init__(self, model_path: str | None = None, **_: object) -> None:
        try:
            from kokoro_onnx import Kokoro
        except ImportError as err:  # pragma: no cover - depends on the install
            raise RuntimeError(
                "kokoro is not installed in the sidecar environment. Run "
                "`npm run voice:install -- kokoro`."
            ) from err

        root = Path(model_path) if model_path else None
        if not root or not root.is_dir():
            raise RuntimeError(
                "kokoro's model files are not downloaded yet. Press Download in the "
                "editor's model picker, or run `npm run voice:fetch -- kokoro`."
            )

        model = root / MODEL_FILE
        voices = root / VOICES_FILE
        for path in (model, voices):
            if not path.is_file():
                raise RuntimeError(f"missing {path.name} in {root}")

        log(f"loading weights from {root}")
        self._kokoro = Kokoro(str(model), str(voices))
        self.sample_rate = 24000

    def voices(self) -> list[str]:
        return sorted(self._kokoro.get_voices())

    def info(self) -> dict[str, object]:
        return {
            "backend": self.name,
            "device": "cpu",
            "clones": self.clones,
            "voices": self.voices(),
            "sampleRate": self.sample_rate,
        }

    def speak(
        self,
        text: str,
        *,
        preset: str | None = None,
        speed: float = 1.0,
        lang: str | None = None,
        **_: object,
    ) -> tuple[np.ndarray, int]:
        voice = preset or "af_heart"
        available = self._kokoro.get_voices()
        if voice not in available:
            raise RuntimeError(
                f"unknown voice {voice!r}. This model has: {', '.join(sorted(available))}"
            )

        samples, rate = self._kokoro.create(
            text,
            voice=voice,
            speed=float(speed),
            lang=lang or ("en-gb" if voice.startswith(BRITISH_PREFIXES) else "en-us"),
        )
        return np.asarray(samples, dtype=np.float32), int(rate)

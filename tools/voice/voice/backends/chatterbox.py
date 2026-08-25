"""
Chatterbox: zero-shot voice cloning from a few seconds of reference audio.

Chosen for this pipeline because a scenario has a cast. Arctic Sentinel has a
narrator, a captain, a transit officer, a legal adviser and two others, and
they have to sound like different people across ninety lines — a model with a
fixed palette of voices gives you a palette, not a cast. One reference clip per
character gives you the cast, and the same clip gives the same voice on every
line, in any order, months apart.

The weights are fetched on first load. `HF_HOME` is set by the editor to the
models root, so they land where the author said models go rather than several
gigabytes into their user profile. If the folder already holds a downloaded
snapshot, that is used directly and nothing touches the network.
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np

from ..protocol import log


class Backend:
    name = "chatterbox"
    clones = True

    def __init__(self, model_path: str | None = None, device: str | None = None, **_: object):
        try:
            import torch
            from chatterbox.tts import ChatterboxTTS
        except ImportError as err:  # pragma: no cover - depends on the install
            raise RuntimeError(
                "chatterbox is not installed in the sidecar environment. "
                "Run the install step in docs/voice-generation.md "
                "(uv sync --extra chatterbox)."
            ) from err

        self._torch = torch
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        if self.device == "cpu":
            # Said out loud, because the difference is a second a line against
            # most of a minute, and the usual cause is a CPU-only torch wheel
            # rather than a machine with no GPU.
            log(
                "chatterbox is running on CPU — generation will be slow. If this "
                "machine has an NVIDIA card, the torch install is probably the "
                "CPU build; see docs/voice-generation.md."
            )

        local = Path(model_path) if model_path else None
        if local and local.is_dir() and any(local.iterdir()):
            log(f"loading weights from {local}")
            self._model = ChatterboxTTS.from_local(str(local), self.device)
        else:
            log(f"loading weights from Hugging Face (cache: {os.environ.get('HF_HOME')})")
            self._model = ChatterboxTTS.from_pretrained(device=self.device)

        self.sample_rate = int(getattr(self._model, "sr", 24000))

    def info(self) -> dict[str, object]:
        cuda = self._torch.cuda
        return {
            "backend": self.name,
            "device": self.device,
            "clones": self.clones,
            "gpu": cuda.get_device_name(0) if cuda.is_available() else None,
            "sampleRate": self.sample_rate,
        }

    def speak(
        self,
        text: str,
        *,
        reference: str | None = None,
        seed: int | None = None,
        exaggeration: float = 0.5,
        cfg_weight: float = 0.5,
        temperature: float = 0.8,
        **_: object,
    ) -> tuple[np.ndarray, int]:
        if reference and not Path(reference).is_file():
            raise RuntimeError(
                f"reference clip not found: {reference}. Set one for this character "
                f"in the editor's Voices panel, or the line will be read in the "
                f"model's default voice."
            )

        # Seeded so a take can be reproduced. Without this, regenerating after a
        # prompt edit changes the performance as well as the words, and there is
        # no way to tell which change you are hearing.
        if seed is not None:
            self._torch.manual_seed(seed)
            if self._torch.cuda.is_available():
                self._torch.cuda.manual_seed_all(seed)

        wav = self._model.generate(
            text,
            audio_prompt_path=reference or None,
            exaggeration=float(exaggeration),
            cfg_weight=float(cfg_weight),
            temperature=float(temperature),
        )

        data = wav.detach().to("cpu").numpy()
        return np.squeeze(data).astype(np.float32), self.sample_rate

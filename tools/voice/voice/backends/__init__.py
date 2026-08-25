"""Backends, chosen by id. Adding one is adding a module and a line here."""

from __future__ import annotations

from typing import Protocol

import numpy as np


class VoiceBackend(Protocol):
    name: str
    sample_rate: int

    def info(self) -> dict[str, object]: ...

    def speak(self, text: str, **kwargs: object) -> tuple[np.ndarray, int]: ...


def load(backend: str, **options: object) -> VoiceBackend:
    if backend == "placeholder":
        from .placeholder import Backend

        return Backend(**options)
    if backend == "chatterbox":
        from .chatterbox import Backend

        return Backend(**options)
    raise RuntimeError(f"unknown voice backend {backend!r}")

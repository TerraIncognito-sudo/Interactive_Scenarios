"""
Writing a take in the format the scenario asked for.

The extension is not cosmetic and not ours to choose. The player opens exactly
the filename `scenario.yaml` declares, so a take written as `.wav` when the
show wants `.mp3` is a file nothing will ever load — and it would look finished
on the board the whole way to the projector. So the format is taken from the
asset's own name, and a format we cannot write is an error at setup rather
than a surprise on the night.
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import soundfile as sf

#: Written straight through by libsndfile. MP3 needs libsndfile 1.1 or newer,
#: which the wheels on PyPI have bundled since soundfile 0.12.
SUPPORTED = {".wav", ".flac", ".ogg", ".mp3"}


class AudioError(RuntimeError):
    pass


def peak_normalise(data: np.ndarray, headroom_db: float = -1.0) -> np.ndarray:
    """
    Brings a clip to a known peak, so takes can be compared by ear.

    Peak rather than loudness: a proper LUFS pass is a job for the mastering
    step, where a whole show is levelled together. Doing it per clip here would
    flatten the difference between a shout and an aside, which is the one thing
    the performance is carrying.
    """
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    if peak <= 0:
        return data
    target = 10.0 ** (headroom_db / 20.0)
    return data * (target / peak)


def write(path: str | os.PathLike[str], data: np.ndarray, samplerate: int) -> float:
    """Writes the clip and returns its length in seconds."""
    target = Path(path)
    suffix = target.suffix.lower()
    if suffix not in SUPPORTED:
        raise AudioError(
            f"cannot write {suffix or 'a file with no extension'} — "
            f"this sidecar writes {', '.join(sorted(SUPPORTED))}"
        )

    data = np.asarray(data, dtype=np.float32)
    if data.ndim > 1:
        data = np.squeeze(data)

    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        sf.write(str(target), data, samplerate)
    except Exception as err:  # noqa: BLE001 - reported to the editor verbatim
        if suffix == ".mp3":
            raise AudioError(
                f"could not write MP3 ({err}). This needs libsndfile 1.1 or newer; "
                f"soundfile {sf.__version__} reports libsndfile "
                f"{sf.__libsndfile_version__}. Upgrading soundfile usually fixes it."
            ) from err
        raise AudioError(f"could not write {target.name}: {err}") from err

    return len(data) / float(samplerate)

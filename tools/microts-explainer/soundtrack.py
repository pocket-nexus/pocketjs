"""Narration and chiptune soundtrack for the MicroTS explainer.

Narration comes from the macOS `say` voices and is cached per line by content
hash, so re-renders reuse the audio. The music is synthesized here: two square
channels and a noise channel, ducked under the narration.
"""
from __future__ import annotations

import array
import hashlib
import math
import subprocess
import wave
from pathlib import Path

RATE = 48000


def _run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, capture_output=True)


def read_wav(path: Path) -> array.array:
    with wave.open(str(path), "rb") as handle:
        if handle.getframerate() != RATE or handle.getnchannels() != 1:
            raise SystemExit(f"{path}: expected mono {RATE} Hz")
        data = array.array("h")
        data.frombytes(handle.readframes(handle.getnframes()))
        return data


def write_wav(path: Path, samples: array.array) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(samples.tobytes())


def speak(text: str, voice: str, rate: int, cache: Path) -> Path:
    """Render one narration line, cached by voice, rate and text."""
    digest = hashlib.sha1(f"{voice}|{rate}|{text}".encode()).hexdigest()[:16]
    out = cache / f"{digest}.wav"
    if out.exists():
        return out
    cache.mkdir(parents=True, exist_ok=True)
    aiff = cache / f"{digest}.aiff"
    _run(["say", "-v", voice, "-r", str(rate), "-o", str(aiff), text])
    _run([
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(aiff),
        "-ac", "1", "-ar", str(RATE),
        "-af", "highpass=f=85,dynaudnorm=f=250:g=5:p=0.62,alimiter=limit=0.92",
        str(out),
    ])
    aiff.unlink(missing_ok=True)
    return out


def duration(path: Path) -> float:
    with wave.open(str(path), "rb") as handle:
        return handle.getnframes() / handle.getframerate()


# ------------------------------------------------------------------ synthesis

def _env(i: int, total: int, attack: int, release: int) -> float:
    if i < attack:
        return i / attack
    if i > total - release:
        return max(0.0, (total - i) / release)
    return 1.0


def square(buf: array.array, start: int, length: int, freq: float, amp: float, duty: float = 0.5) -> None:
    if freq <= 0 or length <= 0:
        return
    period = RATE / freq
    attack = max(1, int(RATE * 0.004))
    release = max(1, int(length * 0.35))
    limit = len(buf)
    for i in range(length):
        index = start + i
        if index >= limit:
            break
        phase = (i % period) / period
        value = amp * _env(i, length, attack, release) * (1.0 if phase < duty else -1.0)
        buf[index] = int(buf[index] + value * 32767)


def noise(buf: array.array, start: int, length: int, amp: float, seed: int = 1) -> None:
    state = seed | 1
    limit = len(buf)
    for i in range(length):
        index = start + i
        if index >= limit:
            break
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        value = ((state >> 14) & 1) * 2 - 1
        buf[index] = int(buf[index] + value * amp * _env(i, length, 1, length) * 32767)


NOTES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def pitch(name: str) -> float:
    """C4 style names; 'r' is a rest."""
    if name == "r":
        return 0.0
    step = NOTES[name[0]]
    octave = int(name[-1])
    return 440.0 * 2 ** ((step + (octave - 4) * 12 - 9) / 12)


LEAD_A = "E5 G5 A5 G5 E5 D5 C5 D5 E5 G5 B5 A5 G5 E5 D5 r".split()
LEAD_B = "C5 E5 G5 E5 A4 C5 E5 D5 F5 A5 G5 E5 D5 C5 D5 r".split()
BASS = "C3 C3 G2 G2 A2 A2 F2 F2 C3 C3 G2 G2 A2 A2 F2 F2".split()


def chiptune(total_samples: int, beat: float = 0.268) -> array.array:
    """Four-bar loop tiled to length, alternating two lead phrases."""
    step = int(RATE * beat)
    loop_len = step * 16
    loops = []
    for lead in (LEAD_A, LEAD_B):
        buf = array.array("h", bytes(loop_len * 2))
        for i, name in enumerate(lead):
            square(buf, i * step, int(step * 0.92), pitch(name), 0.085, 0.5)
        for i, name in enumerate(BASS):
            square(buf, i * step, int(step * 0.8), pitch(name) / 2, 0.075, 0.25)
        for i in range(16):
            noise(buf, i * step, int(step * (0.10 if i % 2 else 0.16)), 0.030 if i % 4 == 2 else 0.018, seed=i + 7)
        loops.append(buf)
    out = array.array("h", bytes(total_samples * 2))
    cursor = 0
    index = 0
    while cursor < total_samples:
        source = loops[index % 2]
        span = min(loop_len, total_samples - cursor)
        out[cursor : cursor + span] = source[:span]
        cursor += span
        index += 1
    return out


def swish(length: float = 0.34, amp: float = 0.16) -> array.array:
    n = int(RATE * length)
    buf = array.array("h", bytes(n * 2))
    state = 12345
    for i in range(n):
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        k = i / n
        band = 1.0 - abs(2 * k - 1)
        value = (((state >> 14) & 1) * 2 - 1) * amp * band * band
        buf[i] = int(value * 32767)
    return buf


def chime(amp: float = 0.14) -> array.array:
    n = int(RATE * 0.7)
    buf = array.array("h", bytes(n * 2))
    for i, note in enumerate(("C5", "E5", "G5", "C6")):
        square(buf, int(i * RATE * 0.09), int(RATE * 0.34), pitch(note), amp, 0.5)
    return buf


def blip(freq: float = 880.0, amp: float = 0.10) -> array.array:
    n = int(RATE * 0.10)
    buf = array.array("h", bytes(n * 2))
    square(buf, 0, n, freq, amp, 0.25)
    return buf


def mix_into(master: array.array, source: array.array, at: float, gain: float = 1.0) -> None:
    start = int(at * RATE)
    limit = len(master)
    for i, value in enumerate(source):
        index = start + i
        if index < 0:
            continue
        if index >= limit:
            break
        master[index] = int(master[index] + value * gain)


def build(track_path: Path, total: float, narration, cues) -> Path:
    """narration: [(seconds, wav path)]; cues: [(seconds, kind)]."""
    total_samples = int((total + 0.6) * RATE)
    voice = array.array("h", bytes(total_samples * 2))
    presence = array.array("f", bytes(total_samples * 4))
    for at, path in narration:
        data = read_wav(path)
        mix_into(voice, data, at, 1.0)
        start = int(at * RATE)
        for i in range(0, len(data), 64):
            index = start + i
            if 0 <= index < total_samples:
                for j in range(min(64, total_samples - index)):
                    presence[index + j] = 1.0
    music = chiptune(total_samples)
    for at, kind in cues:
        if kind == "swish":
            mix_into(music, swish(), at, 1.0)
        elif kind == "chime":
            mix_into(music, chime(), at, 1.0)
        elif kind == "blip":
            mix_into(music, blip(), at, 1.0)
    # duck the music while a line plays, with a short release
    duck = 0.0
    master = array.array("h", bytes(total_samples * 2))
    attack = 1.0 / (RATE * 0.05)
    release = 1.0 / (RATE * 0.35)
    for i in range(total_samples):
        target = presence[i]
        duck += min(attack, max(-release, target - duck)) if target > duck else -min(release, duck - target)
        gain = 1.0 - 0.55 * duck
        value = music[i] * gain + voice[i]
        master[i] = 32767 if value > 32767 else (-32768 if value < -32768 else int(value))
    write_wav(track_path, master)
    return track_path

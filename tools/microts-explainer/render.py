#!/usr/bin/env python3
"""Render the MicroTS explainer video.

    python3 tools/microts-explainer/render.py                 # full video with narration
    python3 tools/microts-explainer/render.py --stills        # one PNG per scene
    python3 tools/microts-explainer/render.py --scene trait   # one chapter, for iteration

Output goes to the ignored dist/microts-explainer/ directory: the MP4, the
stills, the mixed audio track and a JSON receipt of the run.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import multiprocessing as mp
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import soundtrack as st  # noqa: E402
import stagecraft as sg  # noqa: E402
from storyboard import SCENES, Ctx  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "dist" / "microts-explainer"
GAP = 0.30


def estimate(text: str) -> float:
    cjk = sum(1 for ch in text if "⺀" <= ch <= "鿿" or "＀" <= ch <= "￯")
    return max(1.6, cjk * 0.156 + (len(text) - cjk) * 0.075)


def plan(scenes, voice: str, rate: int, with_audio: bool):
    """Lay every scene on the clock from the length of its spoken lines."""
    cache = OUT / "voice"
    clock = 0.0
    narration: list = []
    cues: list = []
    plan_scenes = []
    for scene in scenes:
        beats = []
        captions = []
        cursor = clock + scene.lead
        for spoken, text in scene.lines:
            if with_audio:
                wav = st.speak(spoken, voice, rate, cache)
                length = st.duration(wav)
                narration.append((cursor, wav))
            else:
                length = estimate(spoken)
            beats.append((cursor - clock, cursor - clock + length + GAP))
            captions.append(text)
            cursor += length + GAP
        duration = cursor - clock + scene.tail
        cues.append((clock, "swish"))
        plan_scenes.append(
            {"scene": scene, "start": clock, "duration": duration, "beats": beats, "captions": captions}
        )
        clock += duration
    cues.append((max(0.0, clock - 2.4), "chime"))
    return plan_scenes, clock, narration, cues


def draw_frame(plan_scenes, total: float, at: float, frame: int, width: int) -> "sg.Image":
    entry = plan_scenes[-1]
    for candidate in plan_scenes:
        if at < candidate["start"] + candidate["duration"]:
            entry = candidate
            break
    scene = entry["scene"]
    local = at - entry["start"]
    c = sg.Canvas()
    c.frame = frame
    ctx = Ctx(t=local, dur=entry["duration"], frame=frame, beats=entry["beats"])
    scene.draw(c, ctx)
    index = plan_scenes.index(entry) + 1
    sg.chapter_chip(c, index, scene.chapter)
    line = ""
    for i, (start, end) in enumerate(entry["beats"]):
        if local >= start:
            line = entry["captions"][i]
            appear = local - start
    if line:
        sg.caption(c, line, appear)
    sg.progress_bar(c, at / total if total else 0)
    # chapter entrance and exit dips keep the cuts clean
    fade = 0.0
    if local < 0.26:
        fade = 1.0 - local / 0.26
    if local > entry["duration"] - 0.20:
        fade = max(fade, (local - (entry["duration"] - 0.20)) / 0.20)
    if at < 0.8:
        fade = max(fade, 1.0 - at / 0.8)
    if at > total - 1.0:
        fade = max(fade, (at - (total - 1.0)) / 1.0)
    if fade > 0.01:
        c.blend("#000000", min(1.0, fade))
    image = c.export()
    if width != sg.WIDTH:
        image = image.resize((width, round(width * sg.HEIGHT / sg.WIDTH)), sg.Image.LANCZOS)
    return image


_JOB = {}


def _worker(state) -> None:
    _JOB.update(state)


def _frame_bytes(frame: int) -> bytes:
    image = draw_frame(_JOB["plan"], _JOB["total"], frame / _JOB["fps"], frame, _JOB["width"])
    return image.tobytes()


def render(args) -> None:
    scenes = SCENES
    if args.scene:
        keys = args.scene.split(",")
        scenes = [s for s in SCENES if s.key in keys]
        if not scenes:
            raise SystemExit(f"no scene named {args.scene}; have {[s.key for s in SCENES]}")
    OUT.mkdir(parents=True, exist_ok=True)
    started = time.time()
    plan_scenes, total, narration, cues = plan(scenes, args.voice, args.rate, not args.no_audio)
    print(f"{len(plan_scenes)} scenes, {total:.1f}s, {int(total * args.fps)} frames")
    for entry in plan_scenes:
        print(f"  {entry['scene'].key:<10} {entry['start']:6.1f}s  +{entry['duration']:5.1f}s  {entry['scene'].chapter}")

    if args.stills:
        target = OUT / "stills"
        target.mkdir(parents=True, exist_ok=True)
        for entry in plan_scenes:
            moment = entry["start"] + entry["duration"] * args.still_at
            image = draw_frame(plan_scenes, total, moment, int(moment * args.fps), args.width)
            image.save(target / f"{entry['scene'].key}.png")
            print("still", target / f"{entry['scene'].key}.png")
        return

    audio = None
    if not args.no_audio:
        audio = st.build(OUT / "narration.wav", total, narration, cues)
        print(f"audio mixed in {time.time() - started:.1f}s")

    out_path = Path(args.out) if args.out else OUT / "microts-explainer.mp4"
    height = round(args.width * sg.HEIGHT / sg.WIDTH)
    command = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{args.width}x{height}",
        "-r", str(args.fps), "-i", "-",
    ]
    if audio:
        command += ["-i", str(audio)]
    command += [
        "-c:v", "libx264", "-preset", args.preset, "-crf", str(args.crf),
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    ]
    if audio:
        command += ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k", "-shortest"]
    command += [str(out_path)]

    frames = int(total * args.fps)
    proc = subprocess.Popen(command, stdin=subprocess.PIPE)
    state = {"plan": plan_scenes, "total": total, "fps": args.fps, "width": args.width}
    drawing = time.time()

    def report(frame: int) -> None:
        if frame % (args.fps * 5):
            return
        done = max(frame, 1) / frames
        elapsed = time.time() - drawing
        print(f"\r  {done * 100:5.1f}%  frame {frame}/{frames}  eta {elapsed / done - elapsed:5.0f}s", end="", flush=True)

    if args.jobs > 1:
        with mp.get_context("fork").Pool(args.jobs, initializer=_worker, initargs=(state,)) as pool:
            for frame, payload in enumerate(pool.imap(_frame_bytes, range(frames), chunksize=4)):
                proc.stdin.write(payload)
                report(frame)
    else:
        _worker(state)
        for frame in range(frames):
            proc.stdin.write(_frame_bytes(frame))
            report(frame)
    proc.stdin.close()
    proc.wait()
    print()
    if proc.returncode != 0:
        raise SystemExit(f"ffmpeg exited with {proc.returncode}")

    digest = hashlib.sha256(out_path.read_bytes()).hexdigest()
    try:
        listed = str(out_path.relative_to(ROOT))
    except ValueError:
        listed = str(out_path)
    receipt = {
        "video": listed,
        "sha256": digest,
        "bytes": out_path.stat().st_size,
        "seconds": round(total, 2),
        "fps": args.fps,
        "resolution": f"{args.width}x{height}",
        "voice": None if args.no_audio else f"{args.voice} @ {args.rate} wpm",
        "render_seconds": round(time.time() - started, 1),
        "scenes": [
            {
                "key": entry["scene"].key,
                "chapter": entry["scene"].chapter,
                "start": round(entry["start"], 2),
                "duration": round(entry["duration"], 2),
                "lines": [text for text in entry["captions"]],
            }
            for entry in plan_scenes
        ],
    }
    (OUT / "receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
    print(f"{out_path}  {out_path.stat().st_size / 1e6:.1f} MB  {total:.1f}s  in {time.time() - started:.0f}s")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--crf", type=int, default=19)
    parser.add_argument("--preset", default="medium")
    parser.add_argument("--voice", default="Tingting", help="macOS `say` voice")
    parser.add_argument("--rate", type=int, default=270, help="words per minute for `say`")
    parser.add_argument("--no-audio", action="store_true")
    parser.add_argument("--scene", help="comma separated scene keys")
    parser.add_argument("--stills", action="store_true", help="write one PNG per scene instead of video")
    parser.add_argument("--still-at", type=float, default=0.7, help="fraction into each scene for --stills")
    parser.add_argument("--jobs", type=int, default=max(1, (mp.cpu_count() or 2) - 4), help="parallel frame workers")
    parser.add_argument("--out")
    render(parser.parse_args())


if __name__ == "__main__":
    main()

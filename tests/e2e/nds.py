#!/usr/bin/env python3
"""Run the NDS ROM in the DeSmuME libretro core; no window or BIOS dump needed.

python3 tests/e2e/nds.py --core /path/desmume_libretro.dylib \
    --rom dist/nds/hero-nds.nds --elf dist/nds/hero-nds.elf \
    --nm /path/arm-none-eabi-nm
"""
import argparse
import ctypes as c
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import time
import zlib


class Variable(c.Structure):
    _fields_ = [("key", c.c_char_p), ("value", c.c_char_p)]


class GameInfo(c.Structure):
    _fields_ = [("path", c.c_char_p), ("data", c.c_void_p),
                ("size", c.c_size_t), ("meta", c.c_char_p)]


class SystemInfo(c.Structure):
    _fields_ = [("name", c.c_char_p), ("version", c.c_char_p),
                ("extensions", c.c_char_p), ("fullpath", c.c_bool),
                ("block_extract", c.c_bool)]


def png(path, width, height, rgb):
    def chunk(kind, value):
        return (struct.pack(">I", len(value)) + kind + value +
                struct.pack(">I", zlib.crc32(kind + value)))
    rows = b"".join(b"\0" + rgb[y * width * 3:(y + 1) * width * 3]
                    for y in range(height))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" +
                     chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) +
                     chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


class Emulator:
    def __init__(self, core_path, rom, output):
        self.core = c.CDLL(str(core_path))
        self.directory = os.fsencode(output)
        self.options = {
            b"desmume_cpu_mode": b"interpreter",
            b"desmume_num_cores": b"1",
            b"desmume_use_external_bios": b"disabled",
            b"desmume_boot_into_bios": b"disabled",
            b"desmume_opengl_mode": b"disabled",
            b"desmume_internal_resolution": b"256x192",
            b"desmume_screens_layout": b"top/bottom",
            b"desmume_screens_gap": b"0",
            b"desmume_pointer_mouse": b"enabled",
            b"desmume_pointer_type": b"touch",
        }
        self.pixel_format = 0
        self.frame = None
        self.buttons = set()
        self.touch = None
        self.frames = 0
        self.callbacks = []
        # libretro logging is variadic; we retain the format string without
        # interpreting its arguments, which ctypes cannot portably forward.
        log_type = c.CFUNCTYPE(None, c.c_int, c.c_char_p)
        self.log_callback = log_type(lambda level, message: None)

        def environment(command, data):
            if command == 27:
                c.cast(data, c.POINTER(c.c_void_p))[0] = c.cast(self.log_callback, c.c_void_p).value
                return True
            if command in (9, 30, 31):  # system/content/save directories
                c.cast(data, c.POINTER(c.c_char_p))[0] = self.directory
                return True
            if command == 10:  # pixel format
                self.pixel_format = c.cast(data, c.POINTER(c.c_uint))[0]
                return self.pixel_format in (0, 1, 2)
            if command == 15:  # get variable
                var = c.cast(data, c.POINTER(Variable)).contents
                var.value = self.options.get(var.key)
                return var.value is not None
            if command == 16:  # legacy core options, first option is default
                variables = c.cast(data, c.POINTER(Variable))
                index = 0
                while variables[index].key:
                    entry = variables[index]
                    self.options.setdefault(entry.key, entry.value.split(b"; ", 1)[1].split(b"|")[0])
                    index += 1
                return True
            if command == 17:
                c.cast(data, c.POINTER(c.c_bool))[0] = False
                return True
            if command == 52:  # core options version: request legacy options
                c.cast(data, c.POINTER(c.c_uint))[0] = 0
                return True
            if command == 3:  # can dupe
                c.cast(data, c.POINTER(c.c_bool))[0] = True
                return True
            if command == 39:  # language: English
                c.cast(data, c.POINTER(c.c_uint))[0] = 0
                return True
            return command in (11, 18, 32, 37)

        def video(data, width, height, pitch):
            if data and data != c.c_void_p(-1).value:
                self.frame = (width, height, pitch, c.string_at(data, height * pitch))

        def input_state(port, device, index, key):
            if port != 0:
                return 0
            if device == 1:  # joypad
                return int(key in self.buttons)
            if device == 6 and self.touch is not None:  # pointer, full two-screen area
                x, y = self.touch
                return (int((x + 0.5) * 65536 / 256) - 32768,
                        int((y + 192.5) * 65536 / 384) - 32768, 1)[key] if key < 3 else 0
            return 0

        definitions = [
            ("environment", c.CFUNCTYPE(c.c_bool, c.c_uint, c.c_void_p), environment),
            ("video_refresh", c.CFUNCTYPE(None, c.c_void_p, c.c_uint, c.c_uint, c.c_size_t), video),
            ("audio_sample", c.CFUNCTYPE(None, c.c_int16, c.c_int16), lambda *_: None),
            ("audio_sample_batch", c.CFUNCTYPE(c.c_size_t, c.c_void_p, c.c_size_t), lambda _, size: size),
            ("input_poll", c.CFUNCTYPE(None), lambda: None),
            ("input_state", c.CFUNCTYPE(c.c_int16, c.c_uint, c.c_uint, c.c_uint, c.c_uint), input_state),
        ]
        for name, callback_type, function in definitions:
            callback = callback_type(function)
            self.callbacks.append(callback)
            getattr(self.core, "retro_set_" + name).argtypes = [callback_type]
            getattr(self.core, "retro_set_" + name)(callback)
        self.core.retro_get_system_info.argtypes = [c.POINTER(SystemInfo)]
        info = SystemInfo()
        self.core.retro_get_system_info(c.byref(info))
        self.identity = {"name": info.name.decode(), "version": info.version.decode()}
        if "DeSmuME" not in self.identity["name"]:
            raise RuntimeError("This harness requires the DeSmuME libretro core")
        self.core.retro_init()
        self.core.retro_load_game.argtypes = [c.POINTER(GameInfo)]
        self.core.retro_load_game.restype = c.c_bool
        self.rom_path = os.fsencode(rom)
        self.rom_data = c.create_string_buffer(rom.read_bytes())
        game = GameInfo(self.rom_path, c.cast(self.rom_data, c.c_void_p), rom.stat().st_size, None)
        if not self.core.retro_load_game(c.byref(game)):
            raise RuntimeError("DeSmuME rejected the ROM")
        self.core.retro_get_memory_data.argtypes = [c.c_uint]
        self.core.retro_get_memory_data.restype = c.c_void_p
        self.core.retro_get_memory_size.argtypes = [c.c_uint]
        self.core.retro_get_memory_size.restype = c.c_size_t
        self.ram = self.core.retro_get_memory_data(2)
        self.ram_size = self.core.retro_get_memory_size(2)
        assert self.ram and self.ram_size == 4 * 1024 * 1024, "Expected original DS 4 MiB RAM"

    def run(self, frames):
        for _ in range(frames):
            self.core.retro_run()
            self.frames += 1

    def read(self, address, length):
        offset = address - 0x02000000
        assert 0 <= offset <= self.ram_size - length, "Telemetry must be in main RAM"
        return c.string_at(self.ram + offset, length)

    def capture(self, path):
        assert self.frame, "No video frames"
        width, height, pitch, pixels = self.frame
        rgb = bytearray()
        for y in range(height):
            row = pixels[y * pitch:(y + 1) * pitch]
            for x in range(width):
                if self.pixel_format == 1:
                    b, g, r, _ = row[x * 4:x * 4 + 4]
                else:
                    value = struct.unpack_from("<H", row, x * 2)[0]
                    if self.pixel_format == 2:
                        r, g, b = ((value >> 11) * 255 // 31,
                                   ((value >> 5) & 63) * 255 // 63, (value & 31) * 255 // 31)
                    else:
                        r, g, b = ((value >> 10) * 255 // 31,
                                   ((value >> 5) & 31) * 255 // 31, (value & 31) * 255 // 31)
                rgb.extend((r, g, b))
        png(path, width, height, rgb)
        return bytes(rgb)

    def close(self):
        self.core.retro_unload_game()
        self.core.retro_deinit()


def symbol(nm, elf, name):
    output = subprocess.check_output([nm, "--defined-only", str(elf)], text=True)
    for line in output.splitlines():
        fields = line.split()
        if len(fields) == 3 and fields[2] == name:
            return int(fields[0], 16)
    raise RuntimeError(f"ELF does not export {name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", required=True, type=Path)
    parser.add_argument("--rom", required=True, type=Path)
    parser.add_argument("--elf", required=True, type=Path)
    parser.add_argument("--nm", default="arm-none-eabi-nm")
    parser.add_argument("--out", type=Path, default=Path(".pocket-build/validation/nds-hero") / time.strftime("%Y%m%d-%H%M%S"))
    parser.add_argument("--smoke-frames", type=int, default=0,
                        help="Capture a fixed number of frames for boot debugging without assertions")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    emulator = Emulator(args.core.resolve(), args.rom.resolve(), args.out.resolve())
    try:
        if args.smoke_frames:
            emulator.run(args.smoke_frames)
            emulator.capture(args.out / "smoke.png")
            (args.out / "ram.bin").write_bytes(emulator.read(0x02000000, emulator.ram_size))
            print(f"Captured {args.smoke_frames} emulator frames in {args.out}", flush=True)
            return
        address = symbol(args.nm, args.elf, "pocket_nds_telemetry")
        fields = ("magic", "version", "status", "frames", "buttons", "counter", "focused",
                  "draw_words", "damage_pixels", "frame_us", "fps_x100", "touch_x", "touch_y",
                  "update_us", "draw_us", "raster_us", "present_us", "copied_pixels",
                  "deadline_misses", "target_fps")
        def status():
            values = struct.unpack("<11I2i7I", emulator.read(address, 80))
            return dict(zip(fields, values))

        def until(predicate, label, limit=1200):
            for _ in range(limit):
                emulator.run(1)
                state = status()
                if state["magic"] == 0x53444E50 and state["status"] in (2, 3, 4, 5):
                    raise AssertionError(f"NDS runtime failed: {state}")
                if predicate(state):
                    print(f"PASS {label}: frame={state['frames']} count={state['counter']}", flush=True)
                    return state
            raise AssertionError(f"Timed out: {label}; {status()}")

        def app_frames(count, label):
            target = status()["frames"] + count
            return until(lambda s: s["frames"] >= target, label)

        state = until(lambda s: s["magic"] == 0x53444E50 and s["version"] == 2
                      and s["status"] == 1 and s["frames"] >= 8, "ROM boot")
        assert state["counter"] == 0 and state["draw_words"] > 0
        assert state["target_fps"] == 30, "Expected the initial 30 FPS host policy"
        boot = emulator.capture(args.out / "boot.png")
        assert emulator.frame[:2] == (256, 384), "Expected two native-resolution DS screens"
        bottom = boot[256 * 192 * 3:]
        colors = set(zip(bottom[0::3], bottom[1::3], bottom[2::3]))
        assert len(colors) > 32, "Hero framebuffer is blank or lacks baked assets"

        # D-pad establishes focus; a held A must only produce one down edge.
        emulator.buttons = {5}  # down
        app_frames(3, "D-pad focus")
        assert status()["focused"] != 0
        emulator.buttons.clear()
        app_frames(2, "D-pad release")
        emulator.buttons = {8}  # A
        until(lambda s: s["counter"] == 1, "A activates generated model")
        app_frames(8, "held A")
        assert status()["counter"] == 1, "Held A repeated the action"
        emulator.buttons.clear()
        app_frames(3, "A release")
        emulator.capture(args.out / "button.png")

        emulator.touch = (240, 5)
        app_frames(4, "touch outside control")
        assert status()["counter"] == 1, "Background tap activated focused control"
        emulator.touch = None
        app_frames(3, "background release")
        emulator.touch = (65, 155)
        until(lambda s: s["counter"] == 2, "tap button label")
        app_frames(8, "held touch")
        assert status()["counter"] == 2, "Held touch repeated the action"
        emulator.touch = (240, 5)
        app_frames(3, "drag off button")
        assert status()["counter"] == 2, "Dragging repeated the action"
        emulator.touch = None
        app_frames(3, "touch release")
        emulator.capture(args.out / "touch.png")

        for expected in (3, 4):
            emulator.buttons = {8}
            until(lambda s: s["counter"] == expected, f"A count {expected}")
            emulator.buttons.clear()
            app_frames(3, "A release")
        final = emulator.capture(args.out / "reactive.png")
        assert final != boot, "Reactive frame did not change"
        before_state = status()
        before = before_state["frames"]
        samples = []
        sampled_frame = before
        for _ in range(600):
            emulator.run(1)
            state = status()
            if state["frames"] != sampled_frame:
                samples.append(state)
                sampled_frame = state["frames"]
        state = status()
        assert 295 <= state["frames"] - before <= 301, "Expected 295–301 application updates per 600 VBlanks at the 30 FPS target"
        assert any(sample["copied_pixels"] == 0 for sample in samples), "Unchanged frames must skip VRAM writes"
        phases = {key: {"mean": round(sum(s[key] for s in samples) / len(samples), 2),
                        "max": max(s[key] for s in samples)}
                  for key in ("update_us", "draw_us", "raster_us", "present_us", "copied_pixels")}
        assert state["status"] == 1 and state["frames"] > before and state["counter"] == 4, state
        emulator.capture(args.out / "steady.png")
        report = {"result": "pass", "emulator": emulator.identity,
                  "emulator_sha256": hashlib.sha256(args.core.read_bytes()).hexdigest(),
                  "rom_sha256": hashlib.sha256(args.rom.read_bytes()).hexdigest(),
                  "rom_bytes": args.rom.stat().st_size, "ram_bytes": emulator.ram_size,
                  "emulated_frames": emulator.frames, "steady_app_frames_per_600_vblanks": state["frames"] - before,
                  "steady_deadline_misses": state["deadline_misses"] - before_state["deadline_misses"],
                  "telemetry": state, "steady_phase_samples": phases, "checks": ["boot", "D-pad focus", "A down edge", "held A",
                  "background touch", "button-label touch", "held touch", "drag", "reactive count 4", "600 VBlank stability", "30 FPS pacing", "idle VRAM skip"]}
        (args.out / "result.json").write_text(json.dumps(report, indent=2) + "\n")
        print(f"PASS NDS Hero: {args.out / 'result.json'}", flush=True)
    except BaseException:
        if emulator.frame:
            emulator.capture(args.out / "failure.png")
        (args.out / "ram.bin").write_bytes(emulator.read(0x02000000, emulator.ram_size))
        raise
    finally:
        emulator.close()


if __name__ == "__main__":
    main()

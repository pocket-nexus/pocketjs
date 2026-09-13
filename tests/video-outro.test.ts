import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TAGLINE,
  parseArgs,
  parseProbeOutput,
  resolveOutroTiming,
  resolveOutputSpec,
  xCompatibilityArgs,
} from "../skills/pocketjs-video-outro/scripts/make-outro.ts";

describe("branding defaults", () => {
  test("uses the current three-line PocketJS positioning", () => {
    const result = parseArgs(["-i", import.meta.path]);
    expect(result.tagline).toBe(DEFAULT_TAGLINE);
    expect(result.tagline.split("\n")).toEqual(["UI for", "every kind of", "computer"]);
  });

  test("keeps an explicitly supplied tagline unchanged", () => {
    const tagline = "A custom line\nwith an intentional break";
    expect(parseArgs(["-i", import.meta.path, "--tagline", tagline]).tagline).toBe(tagline);
  });
});

describe("short outro timing", () => {
  test("defaults to a complete card below three seconds with a readable hold", () => {
    const args = parseArgs(["-i", import.meta.path]);
    const timing = resolveOutroTiming(args.outro, args.xfade);
    const settled = Math.max(...Object.values(timing).map(layer => layer.start + layer.duration));
    expect(args.outro).toBeLessThan(3);
    expect(args.xfade).toBeLessThan(0.5);
    expect(settled).toBeLessThan(1);
    expect(args.outro - settled).toBeGreaterThan(1.5);
  });

  test("keeps ordered entrances after the transition and fits custom card lengths", () => {
    for (const [outro, xfade] of [[2.8,0.35], [1,0.35], [5.5,0.8], [0.5,0.1], [2,0]]) {
      const { logo, tagline, url } = resolveOutroTiming(outro, xfade);
      expect(logo.start).toBe(xfade);
      expect(tagline.start).toBeGreaterThan(logo.start);
      expect(url.start).toBeGreaterThan(tagline.start);
      for (const layer of [logo,tagline,url]) {
        expect(layer.duration).toBeGreaterThan(0);
        expect(layer.start + layer.duration).toBeLessThanOrEqual(xfade + (outro-xfade)/2 + 1e-8);
      }
    }
  });

  test("rejects a transition that would consume the whole card", () => {
    for (const xfade of [1,2]) {
      expect(() => parseArgs(["-i", import.meta.path, "--outro", "1", "--xfade", String(xfade)]))
        .toThrow("--xfade must be shorter than --outro");
    }
  });
});

describe("parseProbeOutput", () => {
  test("reads an iPhone HDR MOV with audio and data streams", () => {
    const result = parseProbeOutput(JSON.stringify({
      streams: [
        {
          codec_type: "video",
          width: 1920,
          height: 1080,
          r_frame_rate: "30/1",
          avg_frame_rate: "30/1",
          color_space: "bt2020nc",
          color_transfer: "arib-std-b67",
          color_primaries: "bt2020",
          color_range: "tv",
          side_data_list: [
            { side_data_type: "DOVI configuration record" },
            { side_data_type: "Ambient viewing environment" },
          ],
        },
        { codec_type: "audio" },
        { codec_type: "audio" },
        { codec_type: "data" },
      ],
      format: { duration: "77.200000" },
    }));

    expect(result).toEqual({
      w: 1920,
      h: 1080,
      rotation: 0,
      fps: 30,
      fpsRate: "30/1",
      dur: 77.2,
      audioStreams: 2,
      colorSpace: "bt2020nc",
      colorTransfer: "arib-std-b67",
      colorPrimaries: "bt2020",
      colorRange: "tv",
    });
  });

  test("prefers the average frame rate for a VFR ReplayKit capture", () => {
    const result = parseProbeOutput(JSON.stringify({
      streams: [
        { codec_type: "video", width: "2200", height: "1428", r_frame_rate: "120/1", avg_frame_rate: "117600/2633" },
      ],
      format: { duration: 43.541667 },
    }));

    expect(result.fps).toBeCloseTo(44.664, 3);
    expect(result.fpsRate).toBe("117600/2633");
  });

  test("falls back to the nominal frame rate when the average is unavailable", () => {
    const result = parseProbeOutput(JSON.stringify({
      streams: [
        { codec_type: "video", width: "1080", height: "1920", r_frame_rate: "30000/1001", avg_frame_rate: "0/0" },
      ],
      format: { duration: 12.5 },
    }));

    expect(result.fps).toBeCloseTo(29.97, 2);
    expect(result.fpsRate).toBe("30000/1001");
  });

  test("uses display dimensions for a rotated portrait video", () => {
    const result = parseProbeOutput(JSON.stringify({
      streams: [{
        codec_type: "video",
        width: 1920,
        height: 1080,
        r_frame_rate: "30/1",
        avg_frame_rate: "30/1",
        side_data_list: [{ rotation: 90 }],
      }],
      format: { duration: 10 },
    }));

    expect({ w: result.w, h: result.h, rotation: result.rotation }).toEqual({ w: 1080, h: 1920, rotation: 90 });
    expect(resolveOutputSpec(result, true)).toEqual({ w: 1068, h: 1900, fps: 30, fpsRate: "30/1" });
  });

  test("normalizes a negative rotation tag", () => {
    const result = parseProbeOutput(JSON.stringify({
      streams: [{
        codec_type: "video",
        width: 1920,
        height: 1080,
        r_frame_rate: "30/1",
        avg_frame_rate: "30/1",
        tags: { rotate: "-90" },
      }],
      format: { duration: 10 },
    }));

    expect({ w: result.w, h: result.h, rotation: result.rotation }).toEqual({ w: 1080, h: 1920, rotation: 270 });
  });

  test("rejects incomplete metadata", () => {
    expect(() => parseProbeOutput('{"streams":[],"format":{}}')).toThrow(
      "could not probe input width/height/fps/duration",
    );
  });
});

describe("resolveOutputSpec", () => {
  test("makes a landscape ReplayKit capture X-compatible", () => {
    expect(resolveOutputSpec({ w: 2200, h: 1428, fps: 44.664, fpsRate: "117600/2633" }, true)).toEqual({
      w: 1664,
      h: 1080,
      fps: 30,
      fpsRate: "30/1",
    });
  });

  test("keeps portrait output within X's 1900px web-upload height", () => {
    expect(resolveOutputSpec({ w: 1440, h: 2560, fps: 60, fpsRate: "60/1" }, true)).toEqual({
      w: 1068,
      h: 1900,
      fps: 30,
      fpsRate: "30/1",
    });
  });

  test("preserves the source spec without the X preset", () => {
    const input = { w: 3840, h: 2160, fps: 60, fpsRate: "60/1" };
    expect(resolveOutputSpec(input, false)).toEqual(input);
  });

  test("does not enlarge an already-small odd-sized source", () => {
    expect(resolveOutputSpec({ w: 1279, h: 719, fps: 24, fpsRate: "24/1" }, true)).toEqual({
      w: 1278,
      h: 718,
      fps: 30,
      fpsRate: "30/1",
    });
  });

  test("fits a 4K source exactly into a 1080p canvas", () => {
    expect(resolveOutputSpec({ w: 3840, h: 2160, fps: 60, fpsRate: "60/1" }, true)).toEqual({
      w: 1920,
      h: 1080,
      fps: 30,
      fpsRate: "30/1",
    });
  });
});

describe("X compatibility CLI", () => {
  test("accepts both X flags and uses a non-destructive output suffix", () => {
    for (const flag of ["--x", "--x-compatible"]) {
      const result = parseArgs(["-i", import.meta.path, flag]);
      expect(result.xCompatible).toBe(true);
      expect(result.output.endsWith("video-outro.test_outro_x.mp4")).toBe(true);
    }
  });

  test("requests CFR, a conventional timebase, and closed GOPs", () => {
    const args = xCompatibilityArgs(true);
    expect(args).toContain("-fps_mode:v");
    expect(args).toContain("cfr");
    expect(args).toContain("30");
    expect(args).toContain("4.0");
    expect(args).toContain("30000");
    expect(args).toContain("+cgop");
    expect(args).toContain("open-gop=0");
    expect(xCompatibilityArgs(false)).toEqual([]);
  });
});

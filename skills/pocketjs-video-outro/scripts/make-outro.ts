#!/usr/bin/env bun
// make-outro.ts — append a PocketJS or Pocket3D end card to a local video.
//
// Renders the card in the Arcade look of pocketjs.dev and 3d.pocket.nexus (the
// mark and wordmark, the headline as candy pixel letters on the hero's marquee
// plate, the url) with headless Chrome, one transparent layer per element, then
// composites it onto the input with a crossfade and a staggered entrance: logo,
// plate, each headline line, url, each dropping in three steps as the sites'
// headline letters do. The source plays
// in full before its held final frame dissolves into the card. The input's primary
// audio track is preserved and faded out by the source's end; the card itself is
// silent (no voiceover). HLG/PQ sources are tone-mapped to BT.709 SDR so the SDR
// browser card and source share one color space in the final H.264 file.
//
// Usage:
//   bun skills/pocketjs-video-outro/scripts/make-outro.ts -i input.mov [-o out.mp4]
//        [--brand pocketjs|pocket3d] [--tagline STR] [--url STR] [--outro SECS]
//        [--xfade SECS] [--crf N] [--preset P] [--x]
//
// Defaults: brand pocketjs ("Create UI on / every screen / you love",
// pocketjs.dev); pocket3d is "Create 3D on / every screen / you love",
// 3d.pocket.nexus. outro 2s, xfade 0.35s, crf 18, preset medium. Pass --url ""
// to hide the url.

import { $ } from "bun";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, basename, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = resolve(HERE, "..", "assets", "outro.html");
// The template loads these beside itself; nothing is fetched from the network.
export const ASSETS = ["press-start-2p-latin.woff2", "Fredoka.ttf", "pocketjs-mark.svg", "pocket3d-mark.svg"]
  .map((name) => resolve(HERE, "..", "assets", name));

/** Each product's wordmark, headline and url, as its site's hero and bar set them. */
export const BRANDS = {
  pocketjs: { word: "PocketJS", tagline: "Create UI on\nevery screen\nyou love", url: "pocketjs.dev" },
  pocket3d: { word: "Pocket3D", tagline: "Create 3D on\nevery screen\nyou love", url: "3d.pocket.nexus" },
} as const;
export type Brand = keyof typeof BRANDS;
export const DEFAULT_TAGLINE = BRANDS.pocketjs.tagline;
export const DEFAULT_OUTRO = 2;
export const DEFAULT_XFADE = 0.35;

/**
 * Keep a readable hold after the stagger, including on shorter custom cards.
 * The plate takes the tagline slot; its lines drop in one after another inside
 * the same window, and the last one lands when the url does.
 */
export function resolveOutroTiming(outro: number, xfade: number, lineCount = 3) {
  if (!Number.isFinite(outro) || outro <= 0) throw new Error("--outro must be a positive number");
  if (!Number.isFinite(xfade) || xfade < 0) throw new Error("--xfade must be a non-negative number");
  if (xfade >= outro) throw new Error("--xfade must be shorter than --outro so the card can appear");
  const pace = Math.min(1, (outro - xfade) / 0.88);
  const step = lineCount > 1 ? (0.12 * pace) / (lineCount - 1) : 0;
  return {
    logo: { start: xfade, duration: 0.25 * pace },
    tagline: { start: xfade + 0.12 * pace, duration: 0.25 * pace },
    lines: Array.from({ length: Math.max(1, lineCount) }, (_, i) => ({
      start: xfade + 0.12 * pace + i * step,
      duration: 0.20 * pace,
    })),
    url: { start: xfade + 0.24 * pace, duration: 0.20 * pace },
  };
}

/**
 * The y offset of a layer dropping in, as an FFmpeg expression of t: three held
 * steps like arcade.css's ar-drop-in (steps(3)): above by `rise`, halfway, a
 * small overshoot below, then rest.
 */
export function dropIn(start: number, duration: number, rise: number): string {
  const p = `clip((t-${start.toFixed(6)})/${duration.toFixed(6)},0,1)`;
  const over = Math.round(rise / 5);
  return `if(lt(${p},1/3),${-rise},if(lt(${p},2/3),${-Math.round(rise / 2)},if(lt(${p},1),${over},0)))`;
}

/** Append the transition after the source, without dimming its final frames. */
export function sourceOutroTransition(duration: number, xfade: number, outputColor = ""): string[] {
  if (xfade === 0) return [`[main][outro]concat=n=2:v=1:a=0,format=yuv420p${outputColor}[v];`];
  const heldUntil = (duration + xfade).toFixed(6);
  return [
    // Trim bounds the clone padding, including when the container's audio
    // outlasts its video. No original frame participates in the dissolve.
    `[main]tpad=stop_mode=clone:stop_duration=${heldUntil},trim=duration=${heldUntil}[held];`,
    `[held][outro]xfade=transition=fade:duration=${xfade}:offset=${duration.toFixed(6)},format=yuv420p${outputColor}[v];`,
  ];
}

type Args = {
  input: string;
  output: string;
  brand: Brand;
  tagline: string;
  url: string;
  outro: number;
  xfade: number;
  crf: number;
  preset: string;
  xCompatible: boolean;
};

function usage(): never {
  console.error(
    [
      "usage:",
      "  bun skills/pocketjs-video-outro/scripts/make-outro.ts -i <input> [options]",
      "",
      "options:",
      "  -o, --output <path>   output file (default: <input>_outro[_x].mp4 next to input)",
      "  --brand <name>        pocketjs or pocket3d: mark, wordmark, headline and url (default: pocketjs)",
      "  --tagline <str>       headline; newlines break it (default: the brand's own)",
      '  --url <str>           footer line (default: the brand\'s site; "" hides it)',
      `  --outro <secs>        appended end-card length including transition (default: ${DEFAULT_OUTRO})`,
      `  --xfade <secs>        crossfade length (default: ${DEFAULT_XFADE})`,
      "  --crf <n>             x264 quality (default: 18)",
      "  --preset <p>          x264 preset (default: medium)",
      "  --x, --x-compatible   export X-safe 30fps CFR within web upload bounds",
    ].join("\n"),
  );
  process.exit(2);
}

function need(v: string | undefined, flag: string): string {
  if (v === undefined || (v.startsWith("--") && v.length > 2)) throw new Error(`${flag} requires a value`);
  return v;
}

export function parseArgs(argv: string[]): Args {
  if (argv.includes("-h") || argv.includes("--help")) usage();
  let input: string | undefined;
  let output: string | undefined;
  let brand: Brand = "pocketjs";
  let tagline: string | undefined;
  let url: string | undefined;
  let outro = DEFAULT_OUTRO;
  let xfade = DEFAULT_XFADE;
  let crf = 18;
  let preset = "medium";
  let xCompatible = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-i" || a === "--input") input = need(argv[++i], a);
    else if (a === "-o" || a === "--output") output = need(argv[++i], a);
    else if (a === "--brand") {
      const name = need(argv[++i], a).toLowerCase();
      if (!(name in BRANDS)) throw new Error(`--brand must be one of: ${Object.keys(BRANDS).join(", ")}`);
      brand = name as Brand;
    }
    else if (a === "--tagline") tagline = need(argv[++i], a);
    else if (a === "--url") url = argv[++i] ?? ""; // allow empty to hide
    else if (a === "--outro") outro = Number(need(argv[++i], a));
    else if (a === "--xfade") xfade = Number(need(argv[++i], a));
    else if (a === "--crf") crf = Number(need(argv[++i], a));
    else if (a === "--preset") preset = need(argv[++i], a);
    else if (a === "--x" || a === "--x-compatible") xCompatible = true;
    else usage();
  }

  if (!input) usage();
  if (!existsSync(input)) throw new Error(`input not found: ${input}`);
  tagline ??= BRANDS[brand].tagline;
  url ??= BRANDS[brand].url;
  resolveOutroTiming(outro, xfade, tagline.split("\n").length);

  if (!output) {
    const dir = resolve(dirname(input));
    const suffix = xCompatible ? "_outro_x.mp4" : "_outro.mp4";
    output = join(dir, `${basename(input, extname(input))}${suffix}`);
  }
  return { input, output, brand, tagline, url, outro, xfade, crf, preset, xCompatible };
}

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

async function findChrome(): Promise<string> {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  for (const name of ["google-chrome", "chromium", "chromium-browser"]) {
    const p = (await $`command -v ${name}`.quiet().nothrow().text()).trim();
    if (p) return p;
  }
  throw new Error("no Chromium-family browser found (Chrome/Chromium/Edge/Brave) for rendering");
}

type ProbeStream = {
  codec_type?: string;
  width?: number | string;
  height?: number | string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_range?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number | string }>;
};

type ProbeOutput = {
  streams?: ProbeStream[];
  format?: { duration?: number | string };
};

function frameRate(value: string | undefined): number {
  if (!value) return 0;
  const [num, den] = value.split("/").map(Number);
  if (Number.isFinite(num) && Number.isFinite(den) && den > 0) return num / den;
  const fps = Number(value);
  return Number.isFinite(fps) ? fps : 0;
}

type ParsedFrameRate = { fps: number; rate: string };

function parsedFrameRate(value: string | undefined): ParsedFrameRate | undefined {
  const fps = frameRate(value);
  return fps > 0 && value ? { fps, rate: value } : undefined;
}

export function displayDimensions(video: ProbeStream) {
  const codedW = Number(video.width);
  const codedH = Number(video.height);
  const sideRotation = video.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation;
  const parsedRotation = Number(sideRotation ?? video.tags?.rotate ?? 0);
  const rotation = Number.isFinite(parsedRotation) ? ((parsedRotation % 360) + 360) % 360 : 0;
  const swapsAxes = Math.abs(rotation - 90) < 0.5 || Math.abs(rotation - 270) < 0.5;
  return swapsAxes
    ? { w: codedH, h: codedW, rotation }
    : { w: codedW, h: codedH, rotation };
}

export function fitWithin(w: number, h: number, maxW: number, maxH: number) {
  const factor = Math.min(1, maxW / w, maxH / h);
  const even = (value: number, limit: number) => (
    Math.min(limit - (limit % 2), Math.max(2, (factor < 1 ? Math.round(value / 2) : Math.floor(value / 2)) * 2))
  );
  return { w: even(w * factor, maxW), h: even(h * factor, maxH) };
}

export function resolveOutputSpec(
  input: { w: number; h: number; fps: number; fpsRate: string },
  xCompatible: boolean,
) {
  if (!xCompatible) return input;
  const limits = input.h > input.w ? { w: 1080, h: 1900 } : { w: 1920, h: 1080 };
  return { ...fitWithin(input.w, input.h, limits.w, limits.h), fps: 30, fpsRate: "30/1" };
}

export function xCompatibilityArgs(enabled: boolean): string[] {
  if (!enabled) return [];
  return [
    "-level:v", "4.0", "-r", "30", "-fps_mode:v", "cfr", "-video_track_timescale", "30000",
    "-g", "60", "-keyint_min", "60", "-sc_threshold", "0", "-flags:v", "+cgop",
    "-x264-params", "open-gop=0", "-maxrate", "8M", "-bufsize", "16M",
  ];
}

export function parseProbeOutput(raw: string) {
  let output: ProbeOutput;
  try {
    output = JSON.parse(raw) as ProbeOutput;
  } catch {
    throw new Error("could not parse ffprobe output");
  }

  const video = output.streams?.find((stream) => stream.codec_type === "video");
  const { w, h, rotation } = displayDimensions(video ?? {});
  // For VFR captures r_frame_rate is often only the stream's smallest frame
  // interval (ReplayKit commonly reports 120/1). avg_frame_rate represents the
  // actual timeline and must win; preserve its rational form for FFmpeg filters.
  const selectedFrameRate = parsedFrameRate(video?.avg_frame_rate) ?? parsedFrameRate(video?.r_frame_rate);
  const fps = selectedFrameRate?.fps ?? 0;
  const fpsRate = selectedFrameRate?.rate ?? "";
  const dur = Number(output.format?.duration);
  const audioStreams = output.streams?.filter((stream) => stream.codec_type === "audio").length ?? 0;
  const colorSpace = video?.color_space ?? "";
  const colorTransfer = video?.color_transfer ?? "";
  const colorPrimaries = video?.color_primaries ?? "";
  const colorRange = video?.color_range ?? "";

  if (![w, h, fps, dur].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("could not probe input width/height/fps/duration");
  }
  return { w, h, rotation, fps, fpsRate, dur, audioStreams, colorSpace, colorTransfer, colorPrimaries, colorRange };
}

async function probe(input: string) {
  const entries = "stream=codec_type,width,height,r_frame_rate,avg_frame_rate,color_space,color_transfer,color_primaries,color_range:stream_tags=rotate:stream_side_data=rotation:format=duration";
  const raw = await $`ffprobe -v error -show_entries ${entries} -of json ${input}`.quiet().text();
  return parseProbeOutput(raw);
}

async function shotLayer(chrome: string, layer: string, out: string, w: number, h: number, params: URLSearchParams) {
  const u = pathToFileURL(HTML);
  u.search = new URLSearchParams({ layer, ...Object.fromEntries(params) }).toString();
  await $`${chrome} --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --default-background-color=00000000 --window-size=${`${w},${h}`} --screenshot=${out} ${u.href}`.quiet().nothrow();
  if (!existsSync(out)) throw new Error(`Chrome failed to render layer "${layer}" -> ${out}`);
}

function round(n: number): number {
  return Math.round(n);
}

const SWSCALE_MATRICES = ["bt601", "bt470", "smpte170m", "bt470bg", "bt709", "fcc", "smpte240m", "bt2020", "bt2020nc"];
const SWSCALE_PRIMARIES = ["bt709", "bt470m", "bt470bg", "smpte170m", "smpte240m", "film", "bt2020", "smpte428", "smpte431", "smpte432", "jedec-p22", "ebu3213"];

function hdrColorValue(value: string, supported: readonly string[], fallback: string, field: string): string {
  if (!value || value === "unknown" || value === "unspecified" || value === "reserved") return fallback;
  if (!supported.includes(value)) throw new Error(`unsupported HDR ${field}: ${value}`);
  return value;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!existsSync(HTML)) throw new Error(`template missing: ${HTML}`);
  for (const asset of ASSETS) if (!existsSync(asset)) throw new Error(`asset missing: ${asset}`);
  await $`command -v ffmpeg`.quiet().then(undefined, () => { throw new Error("ffmpeg not found on PATH"); });
  await $`command -v ffprobe`.quiet().then(undefined, () => { throw new Error("ffprobe not found on PATH"); });

  const chrome = await findChrome();
  const input = await probe(a.input);
  const { w, h, fps, fpsRate } = resolveOutputSpec(input, a.xCompatible);
  const { w: inputW, h: inputH, rotation, fps: inputFps, fpsRate: inputFpsRate, dur, audioStreams, colorSpace, colorTransfer, colorPrimaries, colorRange } = input;
  const isHdr = colorTransfer === "arib-std-b67" || colorTransfer === "smpte2084";
  const isBt709 = colorSpace === "bt709" && colorTransfer === "bt709" && colorPrimaries === "bt709";
  const outputIsBt709Tv = isHdr || (isBt709 && colorRange !== "pc");
  const hdrColorSpace = isHdr
    ? hdrColorValue(colorSpace, SWSCALE_MATRICES, "bt2020nc", "matrix")
    : "";
  const hdrPrimaries = isHdr
    ? hdrColorValue(colorPrimaries, SWSCALE_PRIMARIES, "bt2020", "primaries")
    : "";
  if (isHdr) {
    const scaleHelp = await $`ffmpeg -hide_banner -h filter=scale`.quiet().text();
    if (!scaleHelp.includes("out_transfer") || !scaleHelp.includes("intent")) {
      throw new Error("HDR input requires an ffmpeg build with swscale tone mapping support (FFmpeg 8 or newer)");
    }
  }

  // type tracks resolution across landscape & portrait
  const scale = Math.min(w, h) / 1080;
  const lineCount = a.tagline.split("\n").length;
  // the logo and url drop 16 and 12px at 1080p; a headline line drops 0.6em of its 56px face
  const riseLogo = round(16 * scale);
  const risePlate = round(20 * scale);
  const riseLine = round(34 * scale);
  const riseUrl = round(12 * scale);
  const xfade = a.xfade;
  const offset = dur;
  const timing = resolveOutroTiming(a.outro, xfade, lineCount);

  // gentle audio fade fully completing at the original end
  let afadeDur = xfade + 0.15;
  let afadeSt = dur - afadeDur;
  if (afadeSt < 0) { afadeSt = 0; afadeDur = dur; }

  console.error(`input : ${inputW}x${inputH} @ ${inputFps.toFixed(3)}fps (${inputFpsRate})  dur=${dur}s  audio-streams=${audioStreams}${rotation ? `  rotation=${rotation}` : ""}`);
  console.error(`color : ${[colorSpace, colorTransfer, colorPrimaries, colorRange].filter(Boolean).join("/") || "unspecified"}${isHdr ? " -> bt709 SDR" : ""}`);
  console.error(`video : ${w}x${h} @ ${fps.toFixed(3)}fps (${fpsRate})${a.xCompatible ? "  X-compatible CFR" : ""}`);
  console.error(`card  : scale=${scale.toFixed(4)}  outro=${a.outro}s  xfade=${xfade}s (offset=${offset.toFixed(3)}s)`);
  console.error(`output: ${a.output}`);

  const tmp = mkdtempSync(join(tmpdir(), "pocketjs-outro-"));
  try {
    const params = new URLSearchParams({
      scale: String(scale),
      brand: a.brand,
      tagline: a.tagline,
      url: a.url,
    });
    // every layer after bg enters with a fade of a third of its slot and a stepped drop
    const entering = [
      { layer: "logo", ...timing.logo, rise: riseLogo },
      { layer: "plate", ...timing.tagline, rise: risePlate },
      ...timing.lines.map((line, i) => ({ layer: `line-${i}`, ...line, rise: riseLine })),
      ...(a.url ? [{ layer: "url", ...timing.url, rise: riseUrl }] : []),
    ];
    const bgPath = join(tmp, "l_bg.png");
    await shotLayer(chrome, "bg", bgPath, w, h, params);
    for (const e of entering) await shotLayer(chrome, e.layer, join(tmp, `l_${e.layer}.png`), w, h, params);
    console.error(`rendered card layers (${w}x${h}): bg, ${entering.map((e) => e.layer).join(", ")}`);

    const f = (n: number) => n.toFixed(6);
    const bt709 = "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709";
    const colorFlags = "lanczos+accurate_rnd+full_chroma_int";
    const cardColor = isHdr
      ? `setparams=range=pc:color_primaries=bt709:color_trc=iec61966-2-1:colorspace=gbr,scale=${w}:${h}:in_range=pc:out_range=tv:in_primaries=bt709:out_primaries=bt709:in_transfer=iec61966-2-1:out_transfer=bt709:out_color_matrix=bt709:intent=perceptual:flags=${colorFlags},`
      : `scale=${w}:${h},`;
    const mainColor = isHdr
      ? `scale=${w}:${h}:in_color_matrix=${hdrColorSpace}:out_color_matrix=bt709:in_range=${colorRange === "pc" ? "pc" : "tv"}:out_range=tv:in_primaries=${hdrPrimaries}:out_primaries=bt709:in_transfer=${colorTransfer}:out_transfer=bt709:intent=perceptual:flags=${colorFlags},setsar=1,format=yuv420p,${bt709}`
      : `scale=${w}:${h},setsar=1,format=yuv420p`;
    const outputColor = isHdr ? `,${bt709}` : "";
    const graphLines = [
      `[1:v]${cardColor}setsar=1,fps=${fpsRate},format=yuv420p${outputColor},setpts=PTS-STARTPTS[bg];`,
      ...entering.map((e, i) =>
        `[${i + 2}:v]${cardColor}fps=${fpsRate},format=yuva420p${outputColor},fade=t=in:st=${f(e.start)}:d=${f(e.duration / 3)}:alpha=1,setpts=PTS-STARTPTS[l${i}];`),
      ...entering.map((e, i) =>
        `[${i ? `o${i - 1}` : "bg"}][l${i}]overlay=x=0:y='${dropIn(e.start, e.duration, e.rise)}'${i === entering.length - 1 ? `,format=yuv420p${outputColor},trim=duration=${a.outro},setpts=PTS-STARTPTS[outro]` : `[o${i}]`};`),
      `[0:v]fps=${fpsRate},${mainColor},setpts=PTS-STARTPTS[main];`,
      ...sourceOutroTransition(dur, xfade, outputColor),
    ];

    const maps: string[] = ["-map", "[v]"];
    let audioNote: string;
    if (audioStreams >= 1) {
      graphLines.push(
        `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,afade=t=out:st=${afadeSt.toFixed(3)}:d=${afadeDur.toFixed(3)},apad,asetpts=PTS-STARTPTS[a]`,
      );
      maps.push("-map", "[a]", "-c:a", "aac", "-b:a", "192k");
      audioNote = "primary audio preserved + faded";
    } else {
      maps.push("-an");
      audioNote = "no audio track in source (video-only output)";
    }

    const graphPath = join(tmp, "graph.txt");
    await Bun.write(graphPath, graphLines.join("\n") + "\n");

    const args = [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", a.input,
      "-loop", "1", "-t", String(a.outro), "-i", bgPath,
      ...entering.flatMap((e) => ["-loop", "1", "-t", String(a.outro), "-i", join(tmp, `l_${e.layer}.png`)]),
      "-filter_complex_script", graphPath,
      ...maps,
      "-c:v", "libx264", "-profile:v", "high", "-crf", String(a.crf), "-preset", a.preset, "-pix_fmt", "yuv420p",
      ...(outputIsBt709Tv ? ["-color_range", "tv", "-colorspace", "bt709", "-color_trc", "bt709", "-color_primaries", "bt709"] : []),
      ...xCompatibilityArgs(a.xCompatible),
      "-movflags", "+faststart", "-shortest",
      a.output,
    ];
    await $`ffmpeg ${args}`;

    const outDur = (await $`ffprobe -v error -show_entries format=duration -of csv=p=0 ${a.output}`.quiet().text()).trim().split("\n")[0];
    console.error(`done  : ${a.output}  (${outDur}s, ${audioNote})`);
    console.log(a.output);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

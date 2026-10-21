import { useLayoutEffect, useRef, useState } from "octane";
import { Text, View, type NodeMirror } from "@pocketjs/framework/octane/components";
import { animate, jump } from "@pocketjs/framework/octane/animation";
import { useButtonPress, useFrame } from "@pocketjs/framework/octane/lifecycle";
import { BTN } from "@pocketjs/framework/octane/input";
import { setTextContent } from "@pocketjs/framework/octane";
import { createWavPlayer } from "@pocketjs/framework/octane/audio";

interface Track {
  title: string;
  artist: string;
  /** pak key suffix: audio:wav.<wav> (see apps/music/pak.json + gen-assets.ts). */
  wav: string;
  coverCls: string;
}

const TRACKS: Track[] = [
  {
    title: "MIDNIGHT REPLAY",
    artist: "SYNC PULSE",
    wav: "midnight-replay",
    coverCls:
      "w-16 h-16 rounded-xl shadow-md items-center justify-center bg-gradient-to-b from-blue-500 to-blue-700 border-blue-300 focus:border-slate-900 transition-colors duration-150",
  },
  {
    title: "GLASS HORIZON",
    artist: "AMBER TIDE",
    wav: "glass-horizon",
    coverCls:
      "w-16 h-16 rounded-xl shadow-md items-center justify-center bg-gradient-to-b from-amber-400 to-amber-700 border-amber-300 focus:border-slate-900 transition-colors duration-150",
  },
  {
    title: "STATIC BLOOM",
    artist: "NEON DRIFTERS",
    wav: "static-bloom",
    coverCls:
      "w-16 h-16 rounded-xl shadow-md items-center justify-center bg-gradient-to-b from-cyan-500 to-cyan-700 border-cyan-300 focus:border-slate-900 transition-colors duration-150",
  },
];

const TRACK_FRAMES = 300;
const PROGRESS_TRACK_W = 160;

// Real playback where the host mounts the audio module (a silent no-op
// everywhere else). The player lives at module scope — Octane re-renders the
// component on every state tick, and the stream must not. `audioIndex`
// mirrors the track index for the audio side because next/prev use
// functional setState (the new index isn't in scope at the call site).
const player = createWavPlayer();
let audioIndex = 0;
const loadTrack = (i: number) => player.load(TRACKS[i].wav);
loadTrack(0);
player.play(); // playing starts true

// Continuous motion rides the native animation system, never per-frame JS:
// an Octane state tick replays the whole root — cheap nowhere, ruinous on
// the PSP. The equalizer is four baked keyframe timelines (pocket.json app.theme
// bakes the bars' |sin| curve, phase included, into styles.bin); play/pause
// just switches the animate-eq* classes on and off.

const EQ_BARS_PLAYING = [
  "w-2 rounded-md shadow bg-gradient-to-b from-emerald-500 to-emerald-600 h-[6] animate-eq0",
  "w-2 rounded-md shadow bg-gradient-to-b from-emerald-500 to-emerald-600 h-[6] animate-eq1",
  "w-2 rounded-md shadow bg-gradient-to-b from-emerald-500 to-emerald-600 h-[6] animate-eq2",
  "w-2 rounded-md shadow bg-gradient-to-b from-emerald-500 to-emerald-600 h-[6] animate-eq3",
] as const;
const EQ_BAR_PAUSED = "w-2 rounded-md shadow bg-gradient-to-b from-emerald-500 to-emerald-600 h-[6]";

function Equalizer(props: { playing: boolean }) {
  return (
    <View class="flex-row items-end gap-1 h-16">
      {([0, 1, 2, 3] as const).map((i) => (
        <View key={i} class={props.playing ? EQ_BARS_PLAYING[i] : EQ_BAR_PAUSED} />
      ))}
    </View>
  );
}

// The fill is a native linear tween across the remaining track (re-aimed on
// play/pause) and the percent text updates imperatively via setTextContent —
// the whole progress line costs zero re-renders until the track ends.
function ProgressLine(props: { playing: boolean; onTrackEnd: () => void; key?: number }) {
  const raw = useRef(0);
  const shownPct = useRef(0);
  const fill = useRef<NodeMirror | null>(null);
  const pctText = useRef<NodeMirror | null>(null);

  useLayoutEffect(() => {
    const node = fill.current;
    if (!node) return;
    if (props.playing) {
      const remaining = TRACK_FRAMES - raw.current;
      animate(node, "width", PROGRESS_TRACK_W, { dur: (remaining * 1000) / 60, easing: "linear" });
    } else {
      jump(node, "width", (raw.current / TRACK_FRAMES) * PROGRESS_TRACK_W);
    }
  }, [props.playing]);

  useFrame(() => {
    if (!props.playing) return;
    raw.current += 1;
    if (raw.current >= TRACK_FRAMES) {
      props.onTrackEnd();
      return;
    }
    const pct = Math.round((raw.current / TRACK_FRAMES) * 100);
    if (pct !== shownPct.current) {
      shownPct.current = pct;
      const node = pctText.current;
      if (node) setTextContent(node, `${pct}%`);
    }
  });

  return (
    <View class="flex-row items-center gap-2">
      <View class="w-[160] h-2 rounded-full shadow bg-slate-200 overflow-hidden">
        <View nodeRef={fill} class="h-2 w-0 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600" />
      </View>
      <Text
        nodeRef={(node: NodeMirror | null) => {
          pctText.current = node;
        }}
        class="text-xs text-slate-500"
      >
        0%
      </Text>
    </View>
  );
}

export default function Music() {
  const [trackIndex, setTrackIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  // Bumped on every select/skip: ProgressLine is keyed on it, so its position
  // state remounts to 0 exactly where the other variants reset it — including
  // re-selecting the current track.
  const [session, setSession] = useState(0);
  const track = TRACKS[trackIndex];

  const selectTrack = (i: number) => {
    setTrackIndex(i);
    setSession((s) => s + 1);
    setPlaying(true);
    audioIndex = i;
    loadTrack(i);
    player.play();
  };
  const nextTrack = () => {
    setTrackIndex((i) => (i + 1) % TRACKS.length);
    setSession((s) => s + 1);
    audioIndex = (audioIndex + 1) % TRACKS.length;
    loadTrack(audioIndex);
  };
  const prevTrack = () => {
    setTrackIndex((i) => (i - 1 + TRACKS.length) % TRACKS.length);
    setSession((s) => s + 1);
    audioIndex = (audioIndex - 1 + TRACKS.length) % TRACKS.length;
    loadTrack(audioIndex);
  };

  useButtonPress(BTN.LTRIGGER, prevTrack);
  useButtonPress(BTN.RTRIGGER, nextTrack);
  useFrame(() => player.pump()); // drain the event batch, feed within credit

  return (
    <View class="flex-col w-full h-full p-3 gap-2 bg-gradient-to-b from-slate-50 to-slate-100">
      <View class="flex-row items-end justify-between">
        <View class="flex-col">
          <Text class="text-xs text-blue-600 tracking-wide">POCKETJS SHOWCASE</Text>
          <Text class="text-2xl text-slate-950 font-bold">Now Playing</Text>
        </View>
        <Text class="text-xs text-slate-500">{`TRACK ${trackIndex + 1} / ${TRACKS.length}`}</Text>
      </View>

      <View class="flex-row items-center gap-3">
        <View
          class={track.coverCls}
          focusable
          onPress={() => {
            setPlaying(!playing);
            if (!playing) player.play();
            else player.pause();
          }}
        >
          <Text class="text-base text-white font-bold">{playing ? ">" : "II"}</Text>
        </View>

        <View class="flex-col grow gap-1">
          <Text class="text-base text-slate-950 font-bold">{track.title}</Text>
          <Text class="text-xs text-slate-600">{track.artist}</Text>
          <ProgressLine key={session} playing={playing} onTrackEnd={nextTrack} />
        </View>

        <Equalizer playing={playing} />
      </View>

      <View class="flex-col gap-1">
        {TRACKS.map((t, i) => (
          <View
            key={t.title}
            class={
              trackIndex === i
                ? "flex-row items-center justify-between p-1 rounded-lg shadow bg-blue-50 border-blue-500 focus:border-blue-600 transition-colors duration-150"
                : "flex-row items-center justify-between p-1 rounded-lg shadow bg-white border-slate-200 focus:border-blue-500 transition-colors duration-150"
            }
            focusable
            onPress={() => selectTrack(i)}
          >
            <Text class="text-xs text-slate-900">{t.title}</Text>
            <Text class="text-xs text-slate-500">{t.artist}</Text>
          </View>
        ))}
      </View>

      <Text class="text-xs text-slate-500">UP / DOWN focus - CIRCLE play/select - L/R skip track</Text>
    </View>
  );
}

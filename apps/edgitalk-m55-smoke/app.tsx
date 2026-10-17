// Edgi-Talk home hub and Beat Dash rhythm game.
//
// The screens live in ./screens. This file owns navigation (one vertical strip
// of 400x240 pages), the polled native status, and the game session flow.

import { Show, createSignal } from "solid-js";
import { View, type NodeMirror } from "@pocketjs/framework/components";
import { jump } from "@pocketjs/framework/animation";
import { createGesture } from "@pocketjs/framework/gesture";
import { onFrame, onMount } from "@pocketjs/framework/solid/lifecycle";

import { TICK_HZ } from "./theme.ts";
import {
  game,
  musicCommand,
  readMusic,
  readPc,
  readStatus,
  type DashboardStatus,
  type GameScores,
  type MusicStatus,
  type PcStats,
} from "./native.ts";
import { BUILTIN_SONGS, parseCustomSong, type Song } from "./game/songs.ts";
import type { GameResult } from "./game/result.ts";
import { Home } from "./screens/Home.tsx";
import { Songs } from "./screens/Songs.tsx";
import { Stage } from "./screens/Stage.tsx";
import { Result } from "./screens/Result.tsx";
import { Settings } from "./screens/Settings.tsx";
import { Calendar } from "./screens/Calendar.tsx";
import { PcMonitor } from "./screens/PcMonitor.tsx";

type Route = "home" | "songs" | "play" | "result" | "settings" | "calendar" | "pc";

const PAGE_OFFSET: Record<Route, number> = {
  home: 0,
  songs: -240,
  play: -480,
  result: -720,
  settings: -960,
  calendar: -1200,
  pc: -1440,
};

const HUB_PAGES: Route[] = ["home", "songs", "settings", "calendar", "pc"];

const WARM_ORDER: Route[] = ["songs", "settings", "calendar", "pc"];

interface StageRequest {
  song: Song;
  nonce: number;
}

export default function App() {
  const [route, setRoute] = createSignal<Route>("home");
  const [status, setStatus] = createSignal<DashboardStatus>(readStatus());
  const [music, setMusic] = createSignal<MusicStatus>(readMusic());
  const [pc, setPc] = createSignal<PcStats>(readPc());
  const [scores, setScores] = createSignal<GameScores>(game.scores());
  const [customSong, setCustomSong] = createSignal<Song | undefined>(parseCustomSong(game.customSong()));
  const [stage, setStage] = createSignal<StageRequest | undefined>(undefined);
  const [result, setResult] = createSignal<GameResult | undefined>(undefined);
  const [offset, setOffset] = createSignal(game.offset());
  // Hub pages are mounted the first time they are visited and then only hidden: creating a page
  // costs over a second of JS on the board, a display toggle costs one repaint.
  const [seen, setSeen] = createSignal<Partial<Record<Route, boolean>>>({ home: true });

  let strip: NodeMirror | undefined;
  let frame = 0;
  let nonce = 0;
  let lastSong: Song | undefined;
  let unmountStage = false;
  let calm = 0;

  const songs = (): Song[] => {
    const custom = customSong();
    return custom ? [...BUILTIN_SONGS, custom] : BUILTIN_SONGS;
  };

  const bestScore = () => Math.max(0, ...scores().best);

  const pageClass = (page: Route) => (route() === page ? "absolute left-0 top-0 w-[400] h-[1680]" : "hidden");

  function go(next: Route): void {
    const previous = route();
    if (previous === next || !strip) return;
    // The game needs the whole frame budget: drop every hub page while it runs.
    if (next === "play") setSeen({});
    else if (HUB_PAGES.includes(next)) setSeen((all) => ({ ...all, [next]: true }));
    setRoute(next);
    jump(strip, "translateY", PAGE_OFFSET[next]);
    if (next === "songs") {
      setCustomSong(parseCustomSong(game.customSong()));
      setScores(game.scores());
    }
    if (next === "home" || next === "songs" || next === "settings" || next === "result") unmountStage = true;
  }

  function startSong(song: Song): void {
    lastSong = song;
    unmountStage = false;
    setStage({ song, nonce: ++nonce });
    go("play");
  }

  function finishSong(finished: GameResult): void {
    if (!finished.failed) game.save(finished.songId, finished.score, finished.rank);
    setScores(game.scores());
    setResult(finished);
    go("result");
  }

  function changeOffset(delta: number): void {
    const next = Math.max(-200, Math.min(200, offset() + delta));
    setOffset(next);
    game.setOffset(next);
  }

  createGesture({
    axis: "y",
    panSlop: 12,
    onPanEnd: (contact) => {
      if (route() === "home" && contact.dy < -32) go("songs");
      else if (route() === "songs" && contact.dy > 32) go("home");
    },
  });

  onMount(() => {
    if (strip) jump(strip, "translateY", 0);
  });

  onFrame(() => {
    frame++;
    if (unmountStage && route() !== "play") {
      unmountStage = false;
      setStage(undefined);
    }
    const current = route();
    // Warm the remaining hub pages while the user is idle on one, one page at a time.
    if (HUB_PAGES.includes(current) || current === "result") {
      if (++calm >= 2 * TICK_HZ) {
        calm = 0;
        const missing = WARM_ORDER.find((page) => !seen()[page]);
        if (missing) setSeen((all) => ({ ...all, [missing]: true }));
      }
    } else {
      calm = 0;
    }
    if (current === "pc" && frame % 15 === 0) setPc(readPc());
    if (current !== "home" && current !== "settings" && current !== "calendar") return;
    if (frame % TICK_HZ === 0) setStatus(readStatus());
    if (current === "home" && frame % 6 === 0) {
      const next = readMusic();
      const previous = music();
      if (
        next.track !== previous.track || next.state !== previous.state ||
        next.volume !== previous.volume || next.count !== previous.count ||
        next.index !== previous.index || next.sd !== previous.sd
      ) {
        setMusic(next);
      }
    }
  });

  return (
    <View debugName="EdgiTalk" class="relative w-full h-full bg-[#e6eff3] overflow-hidden">
      <View
        ref={(node: NodeMirror) => {
          strip = node;
        }}
        class="absolute left-0 top-0 w-[400] h-[1680]"
        style={{ translateY: 0 }}
      >
        {/* Hub pages stay mounted once visited and are only hidden (display: none): the layout and
            draw-list passes skip hidden subtrees, and the software renderer needs hundreds of
            milliseconds to repaint a screen, so pages switch instantly instead of sliding. */}
        <Show when={seen().home}>
          <View class={pageClass("home")}>
            <Home
              status={status}
              music={music}
              bestScore={bestScore}
              musicCommand={musicCommand}
              onPlay={() => go("songs")}
              onSettings={() => go("settings")}
              onCalendar={() => go("calendar")}
              onPc={() => {
                setPc(readPc());
                go("pc");
              }}
            />
          </View>
        </Show>
        <Show when={seen().songs}>
          <View class={pageClass("songs")}>
            <Songs songs={songs} scores={scores} onPick={startSong} onBack={() => go("home")} />
          </View>
        </Show>
        <Show when={stage()} keyed>
          {(request) => (
            <Stage
              song={request.song}
              previousBest={scores().best[request.song.id] ?? 0}
              onExit={() => go("songs")}
              onFinish={finishSong}
            />
          )}
        </Show>
        <Show when={route() === "result"}>
          <Result
            result={result}
            onRetry={() => {
              if (lastSong) startSong(lastSong);
            }}
            onSongs={() => go("songs")}
          />
        </Show>
        <Show when={seen().calendar}>
          <View class={pageClass("calendar")}>
            <Calendar status={status} onBack={() => go("home")} />
          </View>
        </Show>
        <Show when={seen().pc}>
          <View class={pageClass("pc")}>
            <PcMonitor pc={pc} onBack={() => go("home")} />
          </View>
        </Show>
        <Show when={seen().settings}>
          <View class={pageClass("settings")}>
            <Settings
              status={status}
              offset={offset}
              onOffset={changeOffset}
              onBack={() => go("home")}
              onPc={() => {
                setPc(readPc());
                go("pc");
              }}
            />
          </View>
        </Show>
      </View>
    </View>
  );
}

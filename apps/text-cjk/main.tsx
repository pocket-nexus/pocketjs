// @title Pocket Text Lab
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { mount } from "@pocketjs/framework";
import { Text, View } from "@pocketjs/framework/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { openFontArchive, type PreparedText, type TextResource } from "@pocketjs/framework/fonts";
import { ResourceBoundary, pending, type ResourceState } from "@pocketjs/framework/resource";
import { offload } from "@pocketjs/framework/offload";

const modes = ["MUSIC", "CHAPTER 1", "CHAPTER 2", "CACHE PRESSURE", "OVER BUDGET", "MISSING GLYPH"];
const tracks = (text: string) => text.split("\n").filter(line => line.trim()).map((line, index) => {
  const [filename, duration = "--:--", album = "Local library"] = line.split("\t");
  const extension = filename.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? "AUDIO";
  return { index, title: filename.replace(/^\d+\s*-\s*/, "").replace(/\.[a-zA-Z0-9]+$/, ""),
    format: extension.toUpperCase(), duration, album };
});
function Skeleton(props: { music: boolean }) {
  return <View class="w-full h-full flex-col animate-skeleton-pulse" debugName="TextSkeleton">
    <Show when={props.music} fallback={
      <View class="flex-col gap-[12] pt-[5] px-[4]">
        <For each={[180, 438, 416, 438, 386, 438, 260]}>{width =>
          <View class="h-[10] rounded-[3px] bg-slate-600" style={{ width }} />
        }</For>
      </View>
    }>
      <For each={[244, 196, 282, 220]}>{width =>
        <View class="h-[39] flex-row items-center gap-[10] px-[6]">
          <View class="w-[28] h-[28] rounded-[4px] bg-slate-600" />
          <View class="flex-col gap-[6]">
            <View class="h-[10] rounded-[3px] bg-slate-600" style={{ width }} />
            <View class="w-[110] h-[6] rounded-[2px] bg-slate-700" />
          </View>
        </View>
      }</For>
    </Show>
  </View>;
}
function MusicList(props: { text: () => string; selected: () => number }) {
  const songs = createMemo(() => tracks(props.text()));
  const visible = createMemo(() => songs().slice(Math.floor(props.selected() / 4) * 4, Math.floor(props.selected() / 4) * 4 + 4));
  return <View class="w-full h-full flex-col" debugName="MusicList">
    <For each={visible()}>{song =>
      <View class={props.selected() === song.index
        ? "h-[39] flex-row items-center gap-[10] px-[6] rounded-[5px] bg-slate-800"
        : "h-[39] flex-row items-center gap-[10] px-[6]"} debugName={`Track${song.index + 1}`}>
        <View class={props.selected() === song.index
          ? "w-[28] h-[28] rounded-[4px] bg-teal-700 items-center justify-center"
          : "w-[28] h-[28] rounded-[4px] bg-slate-700 items-center justify-center"}>
          <Text class="text-xs text-white">{String(song.index + 1).padStart(2, "0")}</Text>
        </View>
        <View class="w-[352] flex-col overflow-hidden">
          <View class="h-[21] overflow-hidden">
            <Text class="text-base text-white" style={{ fontSlot: 2, lineHeight: 21 }}>{song.title}</Text>
          </View>
          <Text class="text-xs text-slate-400">{`${song.album} / ${song.format}`}</Text>
        </View>
        <Text class="text-xs text-slate-400">{song.duration}</Text>
      </View>
    }</For>
  </View>;
}
function wrap(text: string) {
  return text.split("\n").map(line => {
    const chars = Array.from(line), lines: string[] = [];
    for (let at = 0; at < chars.length; at += 27) lines.push(chars.slice(at, at + 27).join(""));
    return lines.join("\n");
  }).join("\n");
}
function TextLab() {
  const [mode, setMode] = createSignal(0), [page, setPage] = createSignal(0);
  const [pages, setPages] = createSignal(1);
  const [diagnostics, setDiagnostics] = createSignal(false), [selected, setSelected] = createSignal(0);
  const [trackCount, setTrackCount] = createSignal(0);
  const [provider, setProvider] = createSignal<"companion" | "local">("companion");
  const [resource, setResource] = createSignal<TextResource>();
  const [batchState, setBatchState] = createSignal<ResourceState<PreparedText>>(pending());
  const [status, setStatus] = createSignal("Opening companion..."), [metrics, setMetrics] = createSignal("");
  const [phase, setPhase] = createSignal("PENDING"), [paused, setPaused] = createSignal(false);
  let archive: ReturnType<typeof openFontArchive> | undefined, started = false, frames = 0,
    revision = 0, pressure = 0, sourceSession = 0, stop: (() => void) | undefined;
  const requests = new Set<number>();
  const clear = () => { stop?.(); stop = undefined; resource()?.dispose(); setResource(undefined);
    setBatchState(pending()); setPhase("PENDING"); setPage(0); setSelected(0); setTrackCount(0); };
  function read(path: string, token: number, done: (text: string) => void) {
    const client = offload(provider());
    const id = client.request("fs.read-text", path, r => {
      requests.delete(id);
      if (token !== revision) return;
      if (r.ok) done(r.value); else { setPhase("ERROR"); setStatus(r.error); }
    });
    if (id) requests.add(id); else { setPhase("ERROR"); setStatus("Document request budget exceeded; press X"); }
  }
  const cancelReads = () => { for (const id of requests) offload(provider()).cancel(id); requests.clear(); };
  function content() {
    // A selection can supersede the common-set read before the archive exists.
    if (!archive) { boot(); return; }
    const token = ++revision;
    cancelReads(); clear();
    const prepare = (text: string) => {
      if (token !== revision || !archive) return;
      const formatted = mode() === 0 ? text : wrap(text);
      setTrackCount(mode() === 0 ? tracks(text).length : 0);
      setPages(Math.max(1, Math.ceil(mode() === 0 ? trackCount() / 4 : formatted.split("\n").length / 7)));
      try {
        const batch = archive.prepareText(formatted, { slot: 2 });
        setResource(batch);
        const update = () => {
          const s = batch.state(); setBatchState(s); setPhase(s.status.toUpperCase());
          if (s.status === "error") setStatus(String(s.error));
        };
        stop = batch.subscribe(update); update();
      } catch (e) { setPhase("ERROR"); setStatus(String(e)); }
    };
    if (mode() === 3 || mode() === 4) {
      const count = mode() === 4 ? 800 : 320, start = 0x4e00 + pressure++ % 20 * 320;
      prepare(Array.from({ length: count }, (_, i) => String.fromCodePoint(start + i)).join(""));
    } else if (mode() === 5) prepare(String.fromCodePoint(0x10ffff));
    else read(mode() === 0 ? "songs.txt" : `chapter-${mode()}.txt`, token, prepare);
  }
  function boot() {
    sourceSession = offload(provider()).session();
    const token = ++revision;
    cancelReads(); clear(); archive?.dispose(); archive = undefined;
    setStatus("Loading configured resident set...");
    read("common.txt", token, common => {
      archive = openFontArchive({ path: "fonts/cjk.pjfa", slots: [2], provider: provider(), capacity: 768,
        maxBytes: 768 * 1024, resident: [{ slot: 2, text: common }] });
      archive.pause(paused()); content();
    });
  }
  const changeMode = (delta: number) => { const base = diagnostics() ? 3 : 0;
    setMode(base + (mode() - base + delta + 3) % 3); content(); };
  onButtonPress(BTN.RTRIGGER, () => changeMode(1));
  onButtonPress(BTN.LTRIGGER, () => changeMode(-1));
  onButtonPress(BTN.START, () => { setDiagnostics(!diagnostics()); setMode(diagnostics() ? 3 : 0); content(); });
  onButtonPress(BTN.TRIANGLE, () => { setPage((page() + 1) % pages()); if (mode() === 0) setSelected(page() * 4); });
  const selectTrack = (delta: number) => {
    if (mode() !== 0 || phase() !== "READY" || !trackCount()) return;
    setSelected((selected() + delta + trackCount()) % trackCount()); setPage(Math.floor(selected() / 4));
  };
  onButtonPress(BTN.UP, () => selectTrack(-1));
  onButtonPress(BTN.DOWN, () => selectTrack(1));
  onButtonPress(BTN.CIRCLE, () => { setPaused(!paused()); archive?.pause(paused()); });
  onButtonPress(BTN.CROSS, () => mode() === 3 ? content() : boot());
  onButtonPress(BTN.SQUARE, () => { cancelReads(); setProvider(provider() === "companion" ? "local" : "companion"); boot(); });
  onCleanup(() => { revision++; cancelReads(); clear(); archive?.dispose(); });
  onFrame(() => {
    if (!started) { started = true; boot(); }
    const session = offload(provider()).session();
    if (session !== sourceSession) {
      sourceSession = session;
      if (session > 0) { if (archive) content(); else boot(); }
    }
    if (++frames % 15 || !archive) return;
    const s = archive.status(), c = archive.stats();
    if (phase() !== "ERROR") setStatus(s.error || (paused() ? "I/O PAUSED - content waits as one batch" :
      `${provider().toUpperCase()} | ${s.state.toUpperCase()} | common glyphs stay resident`));
    setMetrics(`${c.resident}/768 cells | ${Math.round(c.bytes / 1024)} KiB | ${c.pending} pending | ${c.evictions} evicted`);
  });
  const expectedFailure = () => phase() === "ERROR" && (
    mode() === 4 && status().includes("Text exceeds the available glyph residency budget") ||
    mode() === 5 && status().includes("Font has no glyph for this text"));
  const errorView = () => <View class="flex-col gap-[8] p-[8]" debugName="TextError">
    <Text class="text-base text-amber-300">{expectedFailure()
      ? mode() === 4 ? "Expected: text exceeds the cache budget" : "Expected: character absent from the font"
      : "Unable to load this selection"}</Text>
    <Text class="text-xs text-slate-400">{expectedFailure()
      ? "The whole batch was rejected. START returns to the library."
      : "Press X to retry, or Square to change the provider."}</Text>
  </View>;
  const fallback = () => <Show when={phase() !== "ERROR"} fallback={errorView()}>
    <Skeleton music={mode() === 0} />
  </Show>;
  return (
    <View class="w-full h-full bg-slate-950 flex-col p-2 gap-[2]" debugName="TextLab">
      <View class="flex-row justify-between items-center">
        <Text class="text-base text-white font-bold">{diagnostics() ? "Text Diagnostics" : mode() === 0 ? "Pocket Music" : "Pocket Reader"}</Text>
        <Text class="text-xs text-cyan-300">{`${modes[mode()]} | ${expectedFailure() ? "EXPECTED" : phase()}`}</Text>
      </View>
      <Text class="text-xs text-slate-400">{status()}</Text>
      <View class="h-[156] overflow-hidden flex-col" debugName="DynamicText">
        <Show when={mode() === 0} fallback={
          <Text resource={resource()} class="text-base text-white" debugName="PreparedContent"
            style={{ lineHeight: 22, translateY: -page() * 154 }} fallback={fallback} errorFallback={errorView} />
        }>
          <ResourceBoundary state={batchState} fallback={fallback} errorFallback={errorView}>
            {value => <MusicList text={() => value().text} selected={selected} />}
          </ResourceBoundary>
        </Show>
      </View>
      <Text class="text-xs text-cyan-300">{metrics()}</Text>
      <Text class="text-xs text-slate-400">{mode() === 0
        ? `${trackCount()} tracks | ${trackCount() ? selected() + 1 : 0} selected | UP/DOWN browse`
        : `Page ${page() + 1}/${pages()} | ${diagnostics() ? "Diagnostic input" : "Entire chapter prepared"}`}</Text>
      <Text class="text-xs text-slate-300">L/R view TRI page O pause X reload SQ I/O START tests</Text>
    </View>
  );
}
mount(() => <TextLab />);

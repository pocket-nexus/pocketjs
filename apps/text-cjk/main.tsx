// @title Pocket Text Lab
import { createSignal, onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework";
import { Text, View } from "@pocketjs/framework/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { openFontArchive, type TextResource } from "@pocketjs/framework/fonts";
import { offload } from "@pocketjs/framework/offload";

const modes = ["MUSIC", "CHAPTER 1", "CHAPTER 2", "CACHE PRESSURE", "OVER BUDGET", "MISSING GLYPH"];
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
  const [provider, setProvider] = createSignal<"companion" | "local">("companion");
  const [resource, setResource] = createSignal<TextResource>();
  const [status, setStatus] = createSignal("Opening companion..."), [metrics, setMetrics] = createSignal("");
  const [phase, setPhase] = createSignal("PENDING"), [paused, setPaused] = createSignal(false);
  let archive: ReturnType<typeof openFontArchive> | undefined, started = false, frames = 0,
    revision = 0, pressure = 0, sourceSession = 0, stop: (() => void) | undefined;
  const requests = new Set<number>();
  const clear = () => { stop?.(); stop = undefined; resource()?.dispose(); setResource(undefined); setPhase("PENDING"); setPage(0); };
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
    const token = ++revision;
    cancelReads(); clear();
    if (!archive) return;
    const prepare = (text: string) => {
      if (token !== revision || !archive) return;
      const formatted = wrap(text);
      setPages(Math.max(1, Math.ceil(formatted.split("\n").length / 7)));
      try {
        const batch = archive.prepareText(formatted, { slot: 2 });
        setResource(batch);
        const update = () => {
          const s = batch.state(); setPhase(s.status.toUpperCase());
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
  onButtonPress(BTN.RTRIGGER, () => { setMode((mode() + 1) % modes.length); content(); });
  onButtonPress(BTN.LTRIGGER, () => { setMode((mode() + modes.length - 1) % modes.length); content(); });
  onButtonPress(BTN.TRIANGLE, () => setPage((page() + 1) % pages()));
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
  return (
    <View class="w-full h-full bg-slate-950 flex-col p-2 gap-[2]" debugName="TextLab">
      <View class="flex-row justify-between items-center">
        <Text class="text-base text-white font-bold">Pocket Text Lab</Text>
        <View class="w-[80] h-[6] rounded-[3px] bg-slate-800">
          <View class="w-[16] h-[6] rounded-[3px] bg-cyan-300 animate-frame-motion" debugName="FrameMotion" />
        </View>
        <Text class="text-xs text-cyan-300">{`${modes[mode()]} | ${phase()}`}</Text>
      </View>
      <Text class="text-xs text-slate-400">{status()}</Text>
      <View class="h-[147] overflow-hidden flex-col" debugName="DynamicText">
        <Text resource={resource()} class="text-base text-white" debugName="PreparedContent"
          style={{ lineHeight: 21, translateY: -page() * 147 }}
          fallback={() => phase() === "ERROR"
            ? <Text class="text-base text-amber-300" debugName="DocumentError">Document unavailable. Press X to retry.</Text>
            : <Text class="text-base text-cyan-300" debugName="TextLoading">Loading whole text...</Text>}
          errorFallback={() => <Text class="text-base text-amber-300" debugName="TextError">Text unavailable. Change selection or press X.</Text>} />
      </View>
      <Text class="text-xs text-cyan-300">{metrics()}</Text>
      <Text class="text-xs text-slate-400">{`Page ${page() + 1}/${pages()} | preloads the entire chapter`}</Text>
      <Text class="text-xs text-slate-300">L/R case TRI page O pause X reload SQ provider</Text>
    </View>
  );
}
mount(() => <TextLab />);

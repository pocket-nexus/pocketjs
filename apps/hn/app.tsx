// apps/hn/app.tsx — Hacker News for Pocket on the 3DS.
//
// The touch screen holds the lists: stories under a Top/New/Best/Ask/Show
// segmented control, then a story's comments. The top screen is the reading
// pane: the selected story (title, domain, points, author, age, its text for
// Ask HN), or the selected comment in full. L and R scroll the pane while a
// thread is open; on the story list they change the feed.
//
// Every request rides @pocketjs/framework/net, which on the 3DS goes through
// the linked Mac, two at a time.

import { batch, createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { jump } from "@pocketjs/framework/animation";
import { AuxiliarySurface, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { companionNow } from "@pocketjs/framework/link";
import { createNavStack } from "../home/ui/nav.tsx";
import { ellipsize, FONT, toAscii, wrap } from "../home/ui/text.ts";
import { paintText } from "../home/ui/slots.ts";
import { createPress, createTouchRouter } from "../home/ui/touch.ts";
import { FEEDS, type Item } from "./api.ts";
import { ageLong, domainOf, htmlToText } from "./html.ts";
import { createHnModel } from "./model.ts";
import { commentsPage, listPage, type HnEnv } from "./views.tsx";

const ALL_BUTTONS = 0xffff;
const PANE_TOP = 26;
const PANE_H = 240 - PANE_TOP;
const PANE_W = 372;
/** Line nodes in the pane's pool: more than the pane shows at once. */
const LINE_SLOTS = Array.from({ length: 18 }, (_, index) => index);

interface PaneLine {
  text: string;
  kind: "title" | "meta" | "body" | "author" | "rule" | "context" | "hint";
}

function sameLines(a: PaneLine[], b: PaneLine[]): boolean {
  return a.length === b.length && a.every((line, index) => line.text === b[index]!.text && line.kind === b[index]!.kind);
}

/** Pane lines by item, kept while the item, its story and the minute hold:
 *  the d-pad revisits rows, and wrapping a pane costs milliseconds on an
 *  Old 3DS. */
const paneCache = new Map<number, { item: Item; story: Item | undefined; now: number; lines: PaneLine[] }>();

function paneLinesOf(item: Item, story: Item | undefined, now: number): PaneLine[] {
  const cached = paneCache.get(item.id);
  if (cached && cached.item === item && cached.story === story && cached.now === now) return cached.lines;
  const lines = item.type === "comment" ? commentPaneLines(item, story, now) : storyLines(item, now);
  if (paneCache.size > 200) paneCache.clear();
  paneCache.set(item.id, { item, story, now, lines });
  return lines;
}

function storyLines(item: Item, now: number): PaneLine[] {
  const lines: PaneLine[] = wrap(toAscii(item.title ?? ""), FONT.lgBold, PANE_W, 3).map((text) => ({ text, kind: "title" as const }));
  const domain = domainOf(item.url);
  const meta = [`${item.score ?? 0} points`, item.by ? `by ${toAscii(item.by)}` : "", item.time ? ageLong(item.time, now) : "", `${item.descendants ?? 0} comments`]
    .filter(Boolean)
    .join("  |  ");
  if (domain) lines.push({ text: toAscii(domain), kind: "context" });
  lines.push({ text: ellipsize(meta, FONT.xs, PANE_W), kind: "meta" });
  lines.push({ text: "", kind: "rule" });
  if (item.text) {
    for (const text of wrap(toAscii(htmlToText(item.text)), FONT.sm, PANE_W)) lines.push({ text, kind: "body" });
  } else {
    lines.push({ text: "A or tap: read the comments.  L/R: change the list.", kind: "hint" });
  }
  return lines;
}

function commentPaneLines(comment: Item, story: Item | undefined, now: number): PaneLine[] {
  const lines: PaneLine[] = [];
  if (story?.title) lines.push({ text: ellipsize(toAscii(story.title), FONT.xsBold, PANE_W), kind: "context" });
  lines.push({ text: `${toAscii(comment.by ?? "[deleted]")}  ${comment.time ? ageLong(comment.time, now) : ""}`, kind: "author" });
  lines.push({ text: "", kind: "rule" });
  const text = comment.deleted ? "[deleted]" : comment.dead ? "[flagged]" : toAscii(htmlToText(comment.text ?? ""));
  for (const line of wrap(text, FONT.sm, PANE_W)) lines.push({ text: line, kind: "body" });
  return lines;
}

const LINE_H: Record<PaneLine["kind"], number> = { title: 22, meta: 16, body: 17, author: 18, rule: 9, context: 16, hint: 17 };

export default function HackerNews() {
  const model = createHnModel();
  const press = createPress();
  const [keys, setKeys] = createSignal(false);
  // Ages need minutes, not frames: the clock signal changes once a minute.
  const [now, setNow] = createSignal(Math.floor(companionNow() / 60000) * 60000);
  const [selected, setSelected] = createSignal(0);
  const [paneScroll, setPaneScroll] = createSignal(0);
  let frames = 0;
  onFrame(() => {
    if (++frames % 60 === 0) setNow(Math.floor(companionNow() / 60000) * 60000);
  });

  const env: HnEnv = {
    model,
    press,
    keys,
    now,
    selected,
    select(id) {
      if (id !== selected()) setPaneScroll(0);
      setSelected(id);
    },
  };

  const stack = createNavStack({
    press,
    keys,
    setKeys,
    onExit: () => undefined,
    rootBack: null,
    page(id, nav, layer) {
      return id === "comments" ? commentsPage(env, nav, layer) : listPage(env, nav, layer);
    },
  });
  stack.reset("list");
  model.setFeed("top");

  createTouchRouter({
    surface: "auxiliary",
    press,
    page: () => stack.touch(),
    active: () => !stack.busy(),
    onTouch: () => setKeys(false),
  });

  const inThread = () => stack.top()?.page === "comments";

  // The pane follows the model only while what it shows is still arriving:
  // every story that arrives bumps the version, and re-wrapping the pane for
  // each was a long frame on an Old 3DS. Equal lines do not redraw.
  const pane = createMemo((): PaneLine[] => {
    const id = selected();
    const item = id ? model.client.cached(id) : undefined;
    if (!item) {
      model.version();
      const state = model.state();
      if (state.status === "error") return [{ text: state.error!.title, kind: "title" }, { text: "", kind: "rule" }, ...wrap(state.error!.detail, FONT.sm, PANE_W).map((text) => ({ text, kind: "body" as const }))];
      return [
        { text: "Hacker News", kind: "title" },
        { text: "news.ycombinator.com, through your Mac", kind: "context" },
        { text: "", kind: "rule" },
        { text: "Pick a story on the touch screen. Its title, points and", kind: "body" },
        { text: "text show here; open it to read the comments.", kind: "body" },
      ];
    }
    if (item.type === "comment") {
      const thread = model.thread();
      const story = thread ? model.client.cached(thread.story) : undefined;
      if (thread && !story) model.version();
      return paneLinesOf(item, story, now());
    }
    return paneLinesOf(item, undefined, now());
  }, undefined, { equals: sameLines });
  const placed = createMemo(() => {
    let y = 8;
    return pane().map((line) => {
      const entry = { ...line, y };
      y += LINE_H[line.kind];
      return entry;
    });
  });
  const paneHeight = () => {
    const list = placed();
    const last = list[list.length - 1];
    return last ? last.y + LINE_H[last.kind] + 8 : 0;
  };
  const maxScroll = () => Math.max(0, paneHeight() - PANE_H);
  const visibleLines = () => placed().filter((line) => line.y - paneScroll() > -24 && line.y - paneScroll() < PANE_H);

  // The pane is a fixed pool of line nodes written in place: a new story or
  // comment rewrites texts and offsets, and only a line whose kind changed
  // restyles. Mounting a fresh set per selection cost most of a d-pad step's
  // 60-90 ms on an Old 3DS.
  const lineNodes: NodeMirror[] = [];
  const lineKinds = LINE_SLOTS.map(() => createSignal<PaneLine["kind"]>("body"));
  const lineTops: number[] = LINE_SLOTS.map(() => -1);
  createEffect(() => {
    const lines = visibleLines();
    batch(() => {
      for (const index of LINE_SLOTS) {
        const node = lineNodes[index];
        if (!node) continue;
        const line = lines[index];
        lineKinds[index]![1](line ? line.kind : "body");
        paintText(node, line ? line.text : "");
        const top = line ? (line.kind === "rule" ? line.y + 4 : line.y) : 0;
        if (top !== lineTops[index]) jump(node, "insetT", (lineTops[index] = top));
      }
    });
  });

  onButtonPress(ALL_BUTTONS, (pressed) => {
    if (inThread() && pressed & (BTN.LTRIGGER | BTN.RTRIGGER)) {
      const step = pressed & BTN.LTRIGGER ? -PANE_H + 34 : PANE_H - 34;
      setPaneScroll(Math.max(0, Math.min(maxScroll(), paneScroll() + step)));
      return;
    }
    stack.key(pressed);
  });

  const feedLabel = () => FEEDS.find((feed) => feed.id === model.feed())?.label ?? "Top";

  return (
    <>
      <View class="relative w-full h-full overflow-hidden bg-[#f6f6ef]">
        <View class="absolute left-0 top-[26] w-[400]" style={{ height: PANE_H, translateY: -paneScroll() }}>
          <For each={LINE_SLOTS}>
            {(index) => {
              const kind = lineKinds[index]![0];
              return (
                <Text
                  ref={(node) => (lineNodes[index] = node)}
                  class={kind() === "title"
                    ? "absolute left-[14] text-lg text-black font-bold"
                    : kind() === "meta"
                      ? "absolute left-[14] text-xs text-[#828282]"
                      : kind() === "context"
                        ? "absolute left-[14] text-xs text-[#ff6600] font-bold"
                        : kind() === "author"
                          ? "absolute left-[14] text-sm text-[#3b4a60] font-bold"
                          : kind() === "hint"
                            ? "absolute left-[14] text-sm text-[#a0a6ae]"
                            : kind() === "rule"
                              ? "absolute left-[14] w-[372] h-[1] bg-[#e2dccb]"
                              : "absolute left-[14] text-sm text-[#222222]"}
                >
                  {" "}
                </Text>
              );
            }}
          </For>
        </View>
        <Show when={maxScroll() > 0}>
          <View class="absolute left-[392] w-[3] rounded-[1] bg-[#00000040]" style={{
            insetT: PANE_TOP + 4 + Math.round((PANE_H - 8) * (paneScroll() / Math.max(1, paneHeight()))),
            height: Math.max(12, Math.round((PANE_H - 8) * (PANE_H / Math.max(1, paneHeight())))),
          }} />
        </Show>
        <View class="absolute left-0 top-0 w-[400] h-[26] bg-gradient-to-b from-[#ff8a33] to-[#ef6304]" />
        <View class="absolute left-0 top-0 w-[400] h-[1] bg-[#ffc08a]" />
        <View class="absolute left-0 top-[25] w-[400] h-[1] bg-[#9a3d00]" />
        <View class="absolute left-[6] top-[4] w-[18] h-[18] border border-white bg-[#ff6600]" />
        <Text class="absolute left-[6] top-[5] w-[18] text-sm text-white font-bold text-center">Y</Text>
        <Text class="absolute left-[30] top-[4] text-sm text-white font-bold">Hacker News</Text>
        <Text class="absolute left-[200] top-[6] w-[190] text-xs text-[#fff3e8] font-bold text-right">
          {inThread() ? (maxScroll() > 0 ? "L / R  scroll" : "Comments") : feedLabel()}
        </Text>
      </View>
      <AuxiliarySurface>
        <View class="relative w-full h-full bg-white overflow-hidden">{stack.view()}</View>
      </AuxiliarySurface>
    </>
  );
}

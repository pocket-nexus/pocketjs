// apps/hn/views.tsx — the pages of Hacker News, all on the touch screen: the
// story list under a Top/New/Best/Ask/Show segmented control, and a story's
// thread: the story in full (title, site, points, its text for Ask HN) over
// every comment in full. Rows have measured heights and are placed by
// offset; a fixed pool of slots draws the ones near the visible band
// (ui/slots.ts).

import { batch, createEffect, createMemo, createSignal, For, onMount, Show, type Accessor } from "solid-js";
import { jump } from "@pocketjs/framework/animation";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { Text, View } from "@pocketjs/framework/components";
import { ClassicSpinner } from "@pocketjs/framework/classic";
import type { NodeMirror } from "@pocketjs/framework/renderer";
import { BTN } from "@pocketjs/framework/input";
import type { LayerContext, NavStack, PageContent, PageSpec } from "../home/ui/nav.tsx";
import { ellipsize, FONT, toAscii, wrap } from "../home/ui/text.ts";
import { createSlotPool, paintText, type SlotPool } from "../home/ui/slots.ts";
import type { Press, Target } from "../home/ui/touch.ts";
import { FEEDS, type Item } from "./api.ts";
import { ageText, domainOf, htmlToText } from "./html.ts";
import { flattenThread, MAX_COMMENTS, type HnModel } from "./model.ts";

const W = 320;
const VIEW_H = 204;
const OVERSCAN = 80;
const TITLE_X = 32;
const BUBBLE_W = 36;
const TITLE_W = W - TITLE_X - BUBBLE_W - 14;
const TITLE_LINE = 17;
const META_H = 15;
const MORE_H = 44;
/** The shortest story row: a one-line title. */
const STORY_MIN_H = 8 + TITLE_LINE + META_H + 6;

export interface HnEnv {
  model: HnModel;
  press: Press;
  keys: Accessor<boolean>;
  now: Accessor<number>;
}

/** A rect is in the mounted band around the visible content. */
const NO_ROWS: never[] = [];

// ---- the segmented control -------------------------------------------------------

const SEG_X = 8;
const SEG_W = (W - SEG_X * 2) / FEEDS.length;

export function segmentTargets(env: HnEnv): Target[] {
  return FEEDS.map((feed, index) => ({
    id: `feed.${feed.id}`,
    x: SEG_X + index * SEG_W,
    y: 0,
    w: SEG_W,
    h: 36,
    run: () => env.model.setFeed(feed.id),
  }));
}

export function Segments(props: { env: HnEnv }) {
  const { model, press } = props.env;
  return (
    <>
      <View class="absolute left-[8] top-[5] w-[304] h-[26] rounded-[5] border border-[#9a3d00] bg-gradient-to-b from-[#ffa45e] via-[#ef7420] to-[#df620c]" />
      <For each={FEEDS}>
        {(feed, index) => (
          <>
            <View
              class={model.feed() === feed.id || press.is(`feed.${feed.id}`)
                ? "absolute top-[6] h-[24] bg-gradient-to-b from-[#b84d00] via-[#cf5f0a] to-[#e07018]"
                : "hidden"}
              style={{ insetL: SEG_X + 1 + index() * SEG_W, width: SEG_W - 1 }}
            />
            <Show when={index() > 0}>
              <View class="absolute top-[6] w-[1] h-[24] bg-[#9a3d00]" style={{ insetL: SEG_X + index() * SEG_W }} />
            </Show>
            <Text class="absolute top-[11] text-xs text-[#7a2f00a0] font-bold text-center" style={{ insetL: SEG_X + index() * SEG_W, width: SEG_W }}>{feed.label}</Text>
            <Text class="absolute top-[12] text-xs text-white font-bold text-center" style={{ insetL: SEG_X + index() * SEG_W, width: SEG_W }}>{feed.label}</Text>
          </>
        )}
      </For>
    </>
  );
}

// ---- story rows -------------------------------------------------------------------

export interface StoryRow {
  id: number;
  rank: number;
  item: Item | undefined;
  title: string[];
  meta: string;
  y: number;
  h: number;
}

const titleCache = new Map<number, string[]>();
const NO_TITLE = [""];

function titleLines(item: Item): string[] {
  let lines = titleCache.get(item.id);
  if (!lines) {
    lines = wrap(toAscii(item.title ?? (item.deleted ? "[deleted]" : "Untitled")), FONT.smBold, TITLE_W, 2);
    titleCache.set(item.id, lines);
  }
  return lines;
}

export function storyMeta(item: Item, now: number): string {
  const parts = [`${item.score ?? 0} ${item.score === 1 ? "point" : "points"}`];
  if (item.by) parts.push(toAscii(item.by));
  if (item.time) parts.push(ageText(item.time, now));
  const domain = domainOf(item.url);
  if (domain) parts.push(toAscii(domain));
  return parts.join("  ");
}

/** Meta lines by story, kept until the item or the minute changes: the
 *  list re-lays out once per arriving story, and building and fitting every
 *  row's line each time cost tens of milliseconds on an Old 3DS. */
const metaCache = new Map<number, { item: Item; now: number; line: string }>();

function storyMetaLine(item: Item, now: number): string {
  const cached = metaCache.get(item.id);
  if (cached && cached.item === item && cached.now === now) return cached.line;
  const line = ellipsize(storyMeta(item, now), FONT.xs, TITLE_W);
  if (metaCache.size > 600) metaCache.clear();
  metaCache.set(item.id, { item, now, line });
  return line;
}

/** Rows by id from the last layout: an unchanged row keeps its object, so
 *  the list keeps its nodes while other stories arrive around it. */
const previousRows = new Map<number, StoryRow>();

function storyRows(env: HnEnv): { rows: StoryRow[]; height: number } {
  env.model.version();
  const state = env.model.state();
  const now = env.now();
  let y = 0;
  const rows = state.ids.slice(0, state.shown).map((id, index) => {
    const item = env.model.client.cached(id);
    const title = item ? titleLines(item) : NO_TITLE;
    const h = 8 + title.length * TITLE_LINE + META_H + 6;
    const meta = item ? storyMetaLine(item, now) : "";
    const before = previousRows.get(id);
    const row: StoryRow = before && before.item === item && before.y === y && before.h === h && before.rank === index + 1 && before.meta === meta
      ? before
      : { id, rank: index + 1, item, title, meta, y, h };
    previousRows.set(id, row);
    y += h;
    return row;
  });
  if (previousRows.size > 600) previousRows.clear();
  const more = state.status === "ready" && state.shown < state.ids.length;
  return { rows, height: y + (more ? MORE_H : 0) };
}

/** Focus keys and rows by key for a layout, built when the d-pad first asks
 *  after the layout changed. Scanning the rows with a key built per row
 *  cost milliseconds per d-pad step on an Old 3DS. */
function keyIndex<R extends { id: number }>(rows: () => readonly R[], prefix: string) {
  let built: readonly R[] | null = null;
  let order: string[] = [];
  let byKey = new Map<string, R>();
  return () => {
    const list = rows();
    if (list !== built) {
      built = list;
      order = list.map((row) => prefix + row.id);
      byKey = new Map(list.map((row, index) => [order[index]!, row]));
    }
    return { order, byKey };
  };
}

/** Whether row `id` is lit: pressed, or focused by the d-pad. Pressed and
 *  focused resolve to ids once per change, so a slot that takes a new row
 *  compares numbers instead of building keys. */
function highlight(env: HnEnv, layer: LayerContext, prefix: string): (id: number) => boolean {
  const idOf = (key: string) => (key.startsWith(prefix) ? Number(key.slice(prefix.length)) : 0);
  const pressed = createMemo(() => idOf(env.press.id()));
  const focused = createMemo(() => (env.keys() ? idOf(layer.focus()) : 0));
  return (id) => id === pressed() || id === focused();
}

/** One slot of the story list's pool (ui/slots.ts). Its nodes mount once;
 *  the painter moves the slot, rewrites its texts and recolors it for each
 *  new row, and the highlight recolors it in place. Positions inside the slot
 *  are static classes and flex layout, so a new row costs a few writes and
 *  the slot's own relayout. */
function StorySlot(props: { pool: SlotPool<StoryRow>; slot: number; lit: (id: number) => boolean }) {
  let box!: NodeMirror;
  let wash!: NodeMirror;
  let rank!: NodeMirror;
  let title!: NodeMirror;
  let meta!: NodeMirror;
  let bubble!: NodeMirror;
  let count!: NodeMirror;
  const [id, setId] = createSignal(0);
  const [loaded, setLoaded] = createSignal(false);
  const [counted, setCounted] = createSignal(false);
  const lit = createMemo(() => id() !== 0 && props.lit(id()));
  let hot = false;
  let y = -1;
  let h = -1;
  const recolor = () => {
    const on = lit();
    jump(wash, "opacity", on ? 1 : 0);
    jump(rank, "textColor", on ? "#ffffff" : "#a0a6ae");
    jump(title, "textColor", on ? "#ffffff" : "#111111");
    jump(meta, "textColor", on ? "#d6e6ff" : "#8a9099");
    jump(bubble, "bgColor", on ? "#ffffff" : hot ? "#ff7a1a" : "#b8bec6");
    jump(count, "textColor", on ? "#1466e0" : "#ffffff");
  };
  onMount(() => {
    createEffect(recolor);
    props.pool.attach(props.slot, (row) => batch(() => {
      if (!row) {
        // An empty slot keeps no stale text, drawn or read.
        if (y >= 0) jump(box, "opacity", 0);
        y = -1;
        for (const text of [rank, title, meta, count]) paintText(text, "");
        setId(0);
        return;
      }
      if (y < 0) jump(box, "opacity", 1);
      if (row.y !== y) jump(box, "translateY", (y = row.y));
      if (row.h !== h) jump(box, "height", (h = row.h));
      paintText(rank, String(row.rank));
      paintText(title, row.title.join("\n"));
      paintText(meta, row.meta);
      const item = row.item;
      const total = item?.descendants ?? 0;
      paintText(count, String(total));
      setLoaded(item !== undefined);
      setCounted(!!item && item.type !== "job");
      if (hot !== total > 0) {
        hot = total > 0;
        if (!lit()) jump(bubble, "bgColor", hot ? "#ff7a1a" : "#b8bec6");
      }
      setId(row.id);
    }));
  });
  return (
    <View ref={box} class="absolute left-0 top-0 w-[320] h-[46] opacity-0 contain-strict">
      <View ref={wash} class="absolute inset-0 opacity-0 bg-gradient-to-b from-[#058cf5] to-[#015ee6]" />
      <View class="absolute left-[32] right-0 bottom-0 h-[1] bg-[#e0e0e0]" />
      <Text ref={rank} class="absolute left-0 top-[8] w-[26] text-xs text-[#a0a6ae] font-bold text-right">{" "}</Text>
      <View class={loaded() ? "hidden" : "absolute left-[32] top-[11] w-[208] h-[9] rounded-[4] bg-[#e4e7eb]"} />
      <View class={loaded() ? "hidden" : "absolute left-[32] top-[28] w-[120] h-[7] rounded-[3] bg-[#eef0f2]"} />
      <View class="absolute left-[32] top-[6] flex-col">
        <Text ref={title} class="text-sm text-[#111111] font-bold leading-[17]">{" "}</Text>
        <Text ref={meta} class="mt-[2] text-xs text-[#8a9099]">{" "}</Text>
      </View>
      <View class={counted() ? "absolute right-[10] top-0 bottom-0 flex-col justify-center" : "hidden"}>
        <View ref={bubble} class="h-[18] min-w-[24] px-[6] rounded-[9] bg-[#b8bec6] flex-col justify-center items-center">
          <Text ref={count} class="text-xs text-white font-bold">{" "}</Text>
        </View>
      </View>
    </View>
  );
}

function Centered(props: { title: string; detail: string; spinner?: boolean; button?: { id: string; label: string }; press: Press }) {
  const lines = () => wrap(props.detail, FONT.xs, 260, 4);
  return (
    <>
      <Show when={props.spinner}>
        <View class="absolute left-[149] top-[40]">
          <ClassicSpinner size={22} color={"#8a9099"} />
        </View>
      </Show>
      <Text class="absolute left-0 top-[74] w-[320] text-base text-[#4c566c] font-bold text-center">{props.title}</Text>
      <For each={lines()}>
        {(line, index) => <Text class="absolute left-[30] w-[260] text-xs text-[#6d7584] text-center" style={{ insetT: 98 + index() * 15 }}>{line}</Text>}
      </For>
      <Show when={props.button}>
        {(button) => (
          <>
            <View
              class={props.press.is(button().id)
                ? "absolute left-[100] top-[160] w-[120] h-[30] rounded-[6] border border-[#6f7680] bg-gradient-to-b from-[#9aa1ab] to-[#bfc5cc]"
                : "absolute left-[100] top-[160] w-[120] h-[30] rounded-[6] border border-[#9aa1aa] bg-gradient-to-b from-[#ffffff] to-[#dde1e6]"}
            />
            <Text class="absolute left-[100] top-[167] w-[120] text-sm text-[#d65a00] font-bold text-center">{button().label}</Text>
          </>
        )}
      </Show>
    </>
  );
}

export function listPage(env: HnEnv, stack: NavStack, layer: LayerContext): PageSpec {
  const { model, press } = env;
  const layout = createMemo(() => storyRows(env));
  const listed = () => model.state().status === "ready" && model.state().ids.length > 0;
  // The pool stays mounted across feed changes and reloads; it shows no rows
  // while the list is not ready.
  const pool = createSlotPool(() => (listed() ? layout().rows : NO_ROWS), layer.offset, { view: VIEW_H, overscan: OVERSCAN, minRowH: STORY_MIN_H });
  const lit = highlight(env, layer, "story.");
  const keys = keyIndex(() => layout().rows, "story.");
  const open = (row: StoryRow) => {
    if (!row.item) return;
    model.openThread(row.id);
    stack.push("comments");
  };
  const step = (by: number) => {
    const at = FEEDS.findIndex((feed) => feed.id === model.feed());
    const next = FEEDS[(at + by + FEEDS.length) % FEEDS.length]!;
    model.setFeed(next.id);
  };

  // Nearing the end of the list, by d-pad focus or by scrolling, pages in
  // the next stories.
  createEffect(() => {
    const focused = layer.focus();
    if (!focused) return;
    const row = keys().byKey.get(focused);
    if (row && row.rank >= model.state().shown - 3) model.more();
  });
  // Checked per frame rather than as an effect on the offset, which would
  // rerun on every scrolled frame.
  onFrame(() => {
    if (model.state().status === "ready" && layer.offset() + VIEW_H > layout().height - MORE_H - 40) model.more();
  });
  const content: PageContent = {
    view: () => (
      <>
        <For each={pool.slots}>{(slot) => <StorySlot pool={pool} slot={slot} lit={lit} />}</For>
        <Show when={!listed()}>
          {model.state().status === "error"
            ? <Centered title={model.state().error!.title} detail={model.state().error!.detail} button={{ id: "feed.retry", label: "Try Again" }} press={press} />
            : model.state().status === "ready"
              ? <Centered title="No Stories" detail="This list is empty right now." press={press} />
              : <Centered title="Loading" detail="Fetching the front page through your Mac." spinner press={press} />}
        </Show>
        <Show when={listed() && model.state().shown < model.state().ids.length}>
          <View class="absolute left-[118]" style={{ insetT: layout().height - MORE_H + 13 }}>
            <ClassicSpinner size={18} color={"#8a9099"} />
          </View>
          <Text class="absolute left-[144] text-sm text-[#8a9099] font-bold" style={{ insetT: layout().height - MORE_H + 13 }}>Loading...</Text>
        </Show>
      </>
    ),
    height: () => layout().height,
    focusOrder: () => keys().order,
    targets(top, offset, bottom) {
      const state = model.state();
      if (state.status === "error") return [{ id: "feed.retry", x: 100, y: top + 160 - offset, w: 120, h: 30, run: () => model.reload() }];
      const out: Target[] = [];
      for (const row of layout().rows) {
        const y = top + row.y - offset;
        if (y + row.h <= top || y >= bottom) continue;
        out.push({ id: `story.${row.id}`, x: 0, y, w: W, h: row.h, run: () => open(row) });
      }
      return out;
    },
    span(id) {
      const row = keys().byKey.get(id);
      return row ? [row.y, row.y + row.h] : null;
    },
    activate(id) {
      const row = keys().byKey.get(id);
      if (row) open(row);
      else if (id === "feed.retry") model.reload();
    },
  };

  return {
    title: () => "Hacker News",
    backLabel: "Stories",
    tint: "orange",
    bare: "white",
    titleView: () => <Segments env={env} />,
    fixedTargets: () => segmentTargets(env),
    content,
    key(pressed) {
      if (pressed & BTN.LTRIGGER) step(-1);
      else if (pressed & BTN.RTRIGGER) step(1);
      else if (pressed & BTN.TRIANGLE) model.reload();
      else if (pressed & BTN.CIRCLE && model.state().status === "error") model.reload();
      else return false;
      return true;
    },
  };
}

// ---- the thread -----------------------------------------------------------------

/** Comment text: 13 px type on 16 px lines. */
const BODY_LINE = 16;
const AUTHOR_H = 15;
const ROW_PAD = 7;
/** The shortest comment row: one line of text. */
const COMMENT_MIN_H = ROW_PAD + AUTHOR_H + BODY_LINE + ROW_PAD;
const INDENT = 11;
const HEADER_X = 12;
const HEADER_W = W - HEADER_X * 2;
const HEADER_TITLE_LINE = 19;
const HEADER_TEXT_LINE = 17;

export interface CommentRow {
  id: number;
  /** Nesting depth, capped at 5. */
  depth: number;
  /** The row stands for collapsed replies, drawn dimmed. */
  dim: boolean;
  /** Tapping collapses or expands the replies under it. */
  folds: boolean;
  x: number;
  y: number;
  h: number;
  author: string;
  age: string;
  body: string;
  op: boolean;
}

const bodyCache = new Map<number, { item: Item; width: number; lines: string[] }>();

/** A comment's whole text as plain ASCII lines `width` wide, wrapped once
 *  per item: wrapping a long comment costs milliseconds on an Old 3DS. */
export function commentLines(item: Item, width: number): string[] {
  const cached = bodyCache.get(item.id);
  if (cached && cached.item === item && cached.width === width) return cached.lines;
  const text = item.deleted ? "[deleted]" : item.dead ? "[flagged]" : toAscii(htmlToText(item.text ?? ""));
  const lines = wrap(text, FONT.sm, width);
  if (bodyCache.size > 600) bodyCache.clear();
  bodyCache.set(item.id, { item, width, lines });
  return lines;
}

/** The story at the head of its thread: every line laid out once. */
export interface StoryHeader {
  title: string;
  /** The site, or "" for a text post. */
  site: string;
  meta: string;
  /** The text of an Ask or Show HN post, wrapped; "" when it has none. */
  text: string;
  siteY: number;
  metaY: number;
  textY: number;
  h: number;
}

const headerCache = new Map<number, { item: Item; now: number; header: StoryHeader }>();

export function storyHeader(story: Item, now: number): StoryHeader {
  const cached = headerCache.get(story.id);
  if (cached && cached.item === story && cached.now === now) return cached.header;
  const title = wrap(toAscii(story.title ?? (story.deleted ? "[deleted]" : "Untitled")), FONT.baseBold, HEADER_W);
  const site = story.url ? toAscii(domainOf(story.url)) : "";
  const parts = [`${story.score ?? 0} ${story.score === 1 ? "point" : "points"}`];
  if (story.by) parts.push(`by ${toAscii(story.by)}`);
  if (story.time) parts.push(ageText(story.time, now));
  const count = story.descendants ?? 0;
  parts.push(`${count} ${count === 1 ? "comment" : "comments"}`);
  const text = story.text ? wrap(toAscii(htmlToText(story.text)), FONT.sm, HEADER_W) : [];
  let y = 8 + title.length * HEADER_TITLE_LINE + 2;
  const siteY = y;
  if (site) y += 15;
  const metaY = y;
  y += 15;
  const textY = y + 8;
  if (text.length) y = textY + text.length * HEADER_TEXT_LINE;
  const header: StoryHeader = {
    title: title.join("\n"),
    site,
    meta: ellipsize(parts.join("  |  "), FONT.xs, HEADER_W),
    text: text.join("\n"),
    siteY,
    metaY,
    textY,
    h: y + 10,
  };
  if (headerCache.size > 200) headerCache.clear();
  headerCache.set(story.id, { item: story, now, header });
  return header;
}

const previousComments = new Map<number, CommentRow>();

function sameComment(a: CommentRow, b: CommentRow): boolean {
  return a.depth === b.depth && a.dim === b.dim && a.folds === b.folds && a.x === b.x && a.y === b.y && a.h === b.h &&
    a.author === b.author && a.age === b.age && a.op === b.op && a.body === b.body;
}

function threadRows(env: HnEnv): { header: StoryHeader | null; rows: CommentRow[]; height: number; footer: string } {
  env.model.version();
  const thread = env.model.thread();
  if (!thread) return { header: null, rows: [], height: 0, footer: "" };
  const story = env.model.client.cached(thread.story);
  const now = env.now();
  const header = story ? storyHeader(story, now) : null;
  let y = header ? header.h : 0;
  const rows: CommentRow[] = flattenThread(story, thread).map((comment) => {
    const depth = Math.min(comment.depth, 5);
    const x = 10 + depth * INDENT;
    const collapsed = comment.hidden > 0 || thread.collapsed.has(comment.id);
    const lines = collapsed
      ? [`${comment.hidden} ${comment.hidden === 1 ? "reply" : "replies"} hidden`]
      : commentLines(comment.item, W - x - 10);
    const h = ROW_PAD + AUTHOR_H + lines.length * BODY_LINE + ROW_PAD;
    const next: CommentRow = {
      id: comment.id,
      depth,
      dim: comment.hidden > 0,
      folds: collapsed || (comment.item.kids?.length ?? 0) > 0,
      x,
      y,
      h,
      author: toAscii(comment.item.by ?? "[deleted]"),
      age: comment.item.time ? ageText(comment.item.time, now) : "",
      body: collapsed ? lines[0]! : lines.join("\n"),
      op: !!story?.by && comment.item.by === story.by,
    };
    // An unchanged row keeps its object, so the slot showing it keeps its nodes as they are.
    const before = previousComments.get(comment.id);
    const row = before && sameComment(before, next) ? before : next;
    previousComments.set(comment.id, row);
    y += h;
    return row;
  });
  if (previousComments.size > 600) previousComments.clear();
  const total = story?.descendants ?? 0;
  const loading = thread.pending > 0;
  const footer = thread.error
    ? `${thread.error.title}. Press X to retry.`
    : loading
      ? "Loading comments..."
      : total === 0
        ? "No comments yet."
        : thread.requested >= MAX_COMMENTS && rows.length < total
          ? `Showing ${rows.length} of ${total} comments.`
          : "";
  return { header, rows, height: y + (footer ? 44 : 8), footer };
}

const DEPTH_COLORS = ["#ff9a52", "#7fb0e8", "#8fd18f", "#d59be0", "#c9b37a"];

/** One slot of the thread's pool (ui/slots.ts); painted like StorySlot. */
function CommentSlot(props: { pool: SlotPool<CommentRow>; slot: number; lit: (id: number) => boolean }) {
  let box!: NodeMirror;
  let wash!: NodeMirror;
  let frame!: NodeMirror;
  let rule!: NodeMirror;
  let author!: NodeMirror;
  let age!: NodeMirror;
  let body!: NodeMirror;
  const [id, setId] = createSignal(0);
  const lit = createMemo(() => id() !== 0 && props.lit(id()));
  let op = false;
  let dim = false;
  let depth = -1;
  let y = -1;
  let h = -1;
  let x = -1;
  const recolor = () => {
    const on = lit();
    jump(wash, "opacity", on ? 1 : 0);
    jump(author, "textColor", on ? "#ffffff" : op ? "#e05d00" : "#3b4a60");
    jump(age, "textColor", on ? "#d6e6ff" : "#a0a6ae");
    jump(body, "textColor", on ? "#ffffff" : dim ? "#8a9099" : "#222222");
  };
  onMount(() => {
    createEffect(recolor);
    props.pool.attach(props.slot, (row) => batch(() => {
      if (!row) {
        if (y >= 0) jump(box, "opacity", 0);
        y = -1;
        for (const text of [author, age, body]) paintText(text, "");
        setId(0);
        return;
      }
      if (y < 0) jump(box, "opacity", 1);
      if (row.y !== y) jump(box, "translateY", (y = row.y));
      if (row.h !== h) jump(box, "height", (h = row.h));
      if (row.x !== x) jump(frame, "insetL", (x = row.x));
      if (row.depth !== depth) {
        depth = row.depth;
        jump(rule, "opacity", depth === 0 ? 0 : 1);
        if (depth > 0) jump(rule, "bgColor", DEPTH_COLORS[depth - 1]!);
      }
      paintText(author, row.author);
      paintText(age, row.age);
      paintText(body, row.body);
      const recolorNow = row.op !== op || row.dim !== dim;
      op = row.op;
      dim = row.dim;
      setId(row.id);
      // A highlight change recolors through the effect; a new tone does here.
      if (recolorNow) recolor();
    }));
  });
  return (
    <View ref={box} class="absolute left-0 top-0 w-[320] h-[45] opacity-0 contain-strict">
      <View ref={wash} class="absolute inset-0 opacity-0 bg-gradient-to-b from-[#058cf5] to-[#015ee6]" />
      <View ref={frame} class="absolute left-[10] top-0 right-0 bottom-0">
        <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#e6e6e6]" />
        <View ref={rule} class="absolute left-[-6] top-[4] bottom-[4] w-[2] opacity-0 bg-[#ff9a52]" />
        <View class="absolute left-0 top-[6] flex-row">
          <Text ref={author} class="text-xs text-[#3b4a60] font-bold">{" "}</Text>
          <Text ref={age} class="ml-[6] text-xs text-[#a0a6ae]">{" "}</Text>
        </View>
        <Text ref={body} class="absolute left-0 top-[22] text-sm text-[#222222] leading-[16]">{" "}</Text>
      </View>
    </View>
  );
}

function Header(props: { header: Accessor<StoryHeader> }) {
  const header = props.header;
  return (
    <>
      <View class="absolute left-0 top-0 w-[320] bg-[#f6f6ef]" style={{ height: header().h }} />
      <View class="absolute left-0 w-[320] h-[1] bg-[#e2dccb]" style={{ insetT: header().h - 1 }} />
      <Text class="absolute left-[12] top-[8] text-base text-black font-bold leading-[19]">{header().title}</Text>
      <Show when={header().site}>
        <Text class="absolute left-[12] text-xs text-[#ff6600] font-bold" style={{ insetT: header().siteY }}>{header().site}</Text>
      </Show>
      <Text class="absolute left-[12] text-xs text-[#828282]" style={{ insetT: header().metaY }}>{header().meta}</Text>
      <Show when={header().text}>
        <Text class="absolute left-[12] text-sm text-[#222222] leading-[17]" style={{ insetT: header().textY }}>{header().text}</Text>
      </Show>
    </>
  );
}

export function commentsPage(env: HnEnv, _stack: NavStack, layer: LayerContext): PageSpec {
  const { model } = env;
  const layout = createMemo(() => threadRows(env));
  const header = createMemo(() => layout().header);
  const pool = createSlotPool(() => layout().rows, layer.offset, { view: VIEW_H, overscan: OVERSCAN, minRowH: COMMENT_MIN_H });
  const lit = highlight(env, layer, "comment.");
  const keys = keyIndex(() => layout().rows, "comment.");
  const story = () => {
    const thread = model.thread();
    return thread ? model.client.cached(thread.story) : undefined;
  };
  const fold = (row: CommentRow) => {
    if (row.folds) model.toggle(row.id);
  };
  const content: PageContent = {
    view: () => (
      <>
        <Show when={header()}>{(current) => <Header header={current} />}</Show>
        <For each={pool.slots}>{(slot) => <CommentSlot pool={pool} slot={slot} lit={lit} />}</For>
        <Show when={layout().footer}>
          <Show when={model.thread()?.pending}>
            <View class="absolute left-[92]" style={{ insetT: layout().height - 32 }}>
              <ClassicSpinner size={16} color={"#8a9099"} />
            </View>
          </Show>
          <Text class="absolute left-0 w-[320] text-xs text-[#8a9099] font-bold text-center" style={{ insetT: layout().height - 31 }}>{layout().footer}</Text>
        </Show>
      </>
    ),
    height: () => layout().height,
    focusOrder: () => keys().order,
    targets(top, offset, bottom) {
      const out: Target[] = [];
      for (const row of layout().rows) {
        const y = top + row.y - offset;
        if (y + row.h <= top || y >= bottom) continue;
        out.push({ id: `comment.${row.id}`, x: 0, y, w: W, h: row.h, run: () => fold(row) });
      }
      return out;
    },
    span(id) {
      const row = keys().byKey.get(id);
      return row ? [row.y, row.y + row.h] : null;
    },
    activate(id) {
      const row = keys().byKey.get(id);
      if (row) fold(row);
    },
  };
  return {
    title: () => {
      const count = story()?.descendants ?? 0;
      return `${count} ${count === 1 ? "Comment" : "Comments"}`;
    },
    tint: "orange",
    bare: "white",
    content,
    key(pressed) {
      if (pressed & (BTN.LTRIGGER | BTN.RTRIGGER)) {
        layer.scrollBy(pressed & BTN.LTRIGGER ? -(VIEW_H - 34) : VIEW_H - 34);
        return true;
      }
      if (pressed & BTN.TRIANGLE) {
        const thread = model.thread();
        if (thread) model.openThread(thread.story);
        return true;
      }
      return false;
    },
  };
}

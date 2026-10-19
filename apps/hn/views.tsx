// apps/hn/views.tsx — the touch-screen pages of Hacker News: the story list
// under a Top/New/Best/Ask/Show segmented control, and a story's comment
// thread. Rows have measured heights (two-line titles, wrapped comment
// previews), are placed by offset and only the ones near the visible band
// are mounted.

import { createEffect, createMemo, For, Show, type Accessor } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { ClassicSpinner } from "@pocketjs/framework/classic";
import { BTN } from "@pocketjs/framework/input";
import type { LayerContext, NavStack, PageContent, PageSpec } from "../home/ui/nav.tsx";
import { ellipsize, FONT, measure, toAscii, wrap } from "../home/ui/text.ts";
import type { Press, Target } from "../home/ui/touch.ts";
import { FEEDS, type Item } from "./api.ts";
import { ageText, domainOf, htmlToText } from "./html.ts";
import { flattenThread, MAX_COMMENTS, type FlatComment, type HnModel } from "./model.ts";

const W = 320;
const VIEW_H = 204;
const OVERSCAN = 80;
const TITLE_X = 32;
const BUBBLE_W = 36;
const TITLE_W = W - TITLE_X - BUBBLE_W - 14;
const TITLE_LINE = 17;
const META_H = 15;
const MORE_H = 44;

export interface HnEnv {
  model: HnModel;
  press: Press;
  keys: Accessor<boolean>;
  now: Accessor<number>;
  /** The item the top screen reads (story or comment id). */
  selected: Accessor<number>;
  select(id: number): void;
}

/** A rect is in the mounted band around the visible content. */
const near = (y: number, h: number, offset: number) => y + h > offset - OVERSCAN && y < offset + VIEW_H + OVERSCAN;

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
    const title = item ? titleLines(item) : [""];
    const h = 8 + title.length * TITLE_LINE + META_H + 6;
    const meta = item ? ellipsize(storyMeta(item, now), FONT.xs, TITLE_W) : "";
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

function bubbleWidth(count: number): number {
  return Math.max(24, Math.ceil(measure(String(count), FONT.xsBold)) + 12);
}

function StoryRowView(props: { row: StoryRow; env: HnEnv; lit: Accessor<boolean> }) {
  const row = props.row;
  const item = row.item;
  const count = item?.descendants ?? 0;
  const bubble = bubbleWidth(count);
  return (
    <>
      <View class={props.lit() ? "absolute left-0 w-[320] bg-gradient-to-b from-[#058cf5] to-[#015ee6]" : "hidden"} style={{ insetT: row.y, height: row.h }} />
      <View class="absolute h-[1] bg-[#e0e0e0]" style={{ insetL: TITLE_X, insetT: row.y + row.h - 1, width: W - TITLE_X }} />
      <Text class={props.lit() ? "absolute left-0 w-[26] text-xs text-white font-bold text-right" : "absolute left-0 w-[26] text-xs text-[#a0a6ae] font-bold text-right"} style={{ insetT: row.y + 8 }}>
        {String(row.rank)}
      </Text>
      <Show
        when={item}
        fallback={
          <>
            <View class="absolute h-[9] rounded-[4] bg-[#e4e7eb]" style={{ insetL: TITLE_X, insetT: row.y + 11, width: TITLE_W - 30 }} />
            <View class="absolute h-[7] rounded-[3] bg-[#eef0f2]" style={{ insetL: TITLE_X, insetT: row.y + 28, width: 120 }} />
          </>
        }
      >
        <For each={row.title}>
          {(line, index) => (
            <Text class={props.lit() ? "absolute text-sm text-white font-bold" : "absolute text-sm text-[#111111] font-bold"} style={{ insetL: TITLE_X, insetT: row.y + 6 + index() * TITLE_LINE }}>
              {line}
            </Text>
          )}
        </For>
        <Text class={props.lit() ? "absolute text-xs text-[#d6e6ff]" : "absolute text-xs text-[#8a9099]"} style={{ insetL: TITLE_X, insetT: row.y + 8 + row.title.length * TITLE_LINE }}>
          {row.meta}
        </Text>
        <Show when={item?.type !== "job"}>
          <View
            class={props.lit() ? "absolute h-[18] rounded-[9] bg-white" : count > 0 ? "absolute h-[18] rounded-[9] bg-[#ff7a1a]" : "absolute h-[18] rounded-[9] bg-[#b8bec6]"}
            style={{ insetL: W - 10 - bubble, insetT: row.y + (row.h - 18) / 2, width: bubble }}
          />
          <Text
            class={props.lit() ? "absolute text-xs text-[#1466e0] font-bold text-center" : "absolute text-xs text-white font-bold text-center"}
            style={{ insetL: W - 10 - bubble, insetT: row.y + (row.h - 18) / 2 + 2, width: bubble }}
          >
            {String(count)}
          </Text>
        </Show>
      </Show>
    </>
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
  const visible = createMemo(() => layout().rows.filter((row) => near(row.y, row.h, layer.offset())), undefined, {
    equals: (a, b) => a.length === b.length && a.every((row, index) => row === b[index]),
  });
  const open = (row: StoryRow) => {
    if (!row.item) return;
    env.select(row.id);
    model.openThread(row.id);
    stack.push("comments");
  };
  const step = (by: number) => {
    const at = FEEDS.findIndex((feed) => feed.id === model.feed());
    const next = FEEDS[(at + by + FEEDS.length) % FEEDS.length]!;
    model.setFeed(next.id);
  };

  // The d-pad focus is the story the top screen reads; nearing the end of
  // the list, by focus or by scrolling, pages in the next stories.
  createEffect(() => {
    const row = layout().rows.find((entry) => `story.${entry.id}` === layer.focus());
    if (!row) return;
    env.select(row.id);
    if (row.rank >= model.state().shown - 3) model.more();
  });
  createEffect(() => {
    const height = layout().height;
    if (model.state().status === "ready" && layer.offset() + VIEW_H > height - MORE_H - 40) model.more();
  });
  const content: PageContent = {
    view: () => (
      <Show
        when={model.state().status === "ready" && model.state().ids.length > 0}
        fallback={
          model.state().status === "error"
            ? <Centered title={model.state().error!.title} detail={model.state().error!.detail} button={{ id: "feed.retry", label: "Try Again" }} press={press} />
            : model.state().status === "ready"
              ? <Centered title="No Stories" detail="This list is empty right now." press={press} />
              : <Centered title="Loading" detail="Fetching the front page through your Mac." spinner press={press} />
        }
      >
        <For each={visible()}>
          {(row) => <StoryRowView row={row} env={env} lit={() => press.is(`story.${row.id}`) || (env.keys() && layer.focus() === `story.${row.id}`)} />}
        </For>
        <Show when={model.state().shown < model.state().ids.length}>
          <View class="absolute left-[118]" style={{ insetT: layout().height - MORE_H + 13 }}>
            <ClassicSpinner size={18} color={"#8a9099"} />
          </View>
          <Text class="absolute left-[144] text-sm text-[#8a9099] font-bold" style={{ insetT: layout().height - MORE_H + 13 }}>Loading...</Text>
        </Show>
      </Show>
    ),
    height: () => layout().height,
    focusOrder: () => layout().rows.map((row) => `story.${row.id}`),
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
      const row = layout().rows.find((entry) => `story.${entry.id}` === id);
      return row ? [row.y, row.y + row.h] : null;
    },
    activate(id) {
      const row = layout().rows.find((entry) => `story.${entry.id}` === id);
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

// ---- comment rows -----------------------------------------------------------------

const BODY_LINE = 14;
const PREVIEW_LINES = 4;
const INDENT = 11;

export interface CommentRow {
  id: number;
  comment: FlatComment | null;
  x: number;
  y: number;
  h: number;
  author: string;
  age: string;
  body: string[];
  op: boolean;
}

const bodyCache = new Map<string, string[]>();

/** A comment's text as plain ASCII lines `width` wide. */
export function commentLines(item: Item, width: number, maxLines: number): string[] {
  const key = `${item.id}|${width}|${maxLines}`;
  let lines = bodyCache.get(key);
  if (!lines) {
    const text = item.deleted ? "[deleted]" : item.dead ? "[flagged]" : toAscii(htmlToText(item.text ?? ""));
    lines = wrap(text, FONT.xs, width, maxLines);
    if (bodyCache.size > 600) bodyCache.clear();
    bodyCache.set(key, lines);
  }
  return lines;
}

function threadRows(env: HnEnv): { header: { title: string[]; meta: string; h: number } | null; rows: CommentRow[]; height: number; footer: string } {
  env.model.version();
  const thread = env.model.thread();
  if (!thread) return { header: null, rows: [], height: 0, footer: "" };
  const story = env.model.client.cached(thread.story);
  const now = env.now();
  const title = story ? wrap(toAscii(story.title ?? ""), FONT.baseBold, W - 24, 3) : [];
  const headerH = 10 + title.length * 19 + META_H + 10;
  let y = headerH;
  const rows: CommentRow[] = flattenThread(story, thread).map((comment) => {
    const depth = Math.min(comment.depth, 5);
    const x = 10 + depth * INDENT;
    const body = comment.hidden > 0 || thread.collapsed.has(comment.id)
      ? [`${comment.hidden} ${comment.hidden === 1 ? "reply" : "replies"} hidden`]
      : commentLines(comment.item, W - x - 10, PREVIEW_LINES);
    const h = 7 + 15 + body.length * BODY_LINE + 7;
    const row: CommentRow = {
      id: comment.id,
      comment,
      x,
      y,
      h,
      author: toAscii(comment.item.by ?? "[deleted]"),
      age: comment.item.time ? ageText(comment.item.time, now) : "",
      body,
      op: !!story?.by && comment.item.by === story.by,
    };
    y += h;
    return row;
  });
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
  return {
    header: story ? { title, meta: ellipsize(storyMeta(story, now), FONT.xs, W - 24), h: headerH } : null,
    rows,
    height: y + (footer ? 44 : 8),
    footer,
  };
}

const DEPTH_LINES = ["", "absolute w-[2] bg-[#ff9a52]", "absolute w-[2] bg-[#7fb0e8]", "absolute w-[2] bg-[#8fd18f]", "absolute w-[2] bg-[#d59be0]", "absolute w-[2] bg-[#c9b37a]"] as const;

function CommentRowView(props: { row: CommentRow; lit: Accessor<boolean>; selected: Accessor<boolean> }) {
  const row = props.row;
  const depth = Math.min(row.comment?.depth ?? 0, 5);
  return (
    <>
      <View
        class={props.lit() ? "absolute left-0 w-[320] bg-gradient-to-b from-[#058cf5] to-[#015ee6]" : props.selected() ? "absolute left-0 w-[320] bg-[#fff0e0]" : "hidden"}
        style={{ insetT: row.y, height: row.h }}
      />
      <View class={props.selected() && !props.lit() ? "absolute left-0 w-[3] bg-[#ff7a1a]" : "hidden"} style={{ insetT: row.y, height: row.h }} />
      <View class="absolute h-[1] bg-[#e6e6e6]" style={{ insetL: row.x, insetT: row.y + row.h - 1, width: W - row.x }} />
      <Show when={depth > 0}>
        <View
          class={depth === 1 ? DEPTH_LINES[1] : depth === 2 ? DEPTH_LINES[2] : depth === 3 ? DEPTH_LINES[3] : depth === 4 ? DEPTH_LINES[4] : DEPTH_LINES[5]}
          style={{ insetL: row.x - 6, insetT: row.y + 4, height: row.h - 8 }}
        />
      </Show>
      <Text
        class={props.lit() ? "absolute text-xs text-white font-bold" : row.op ? "absolute text-xs text-[#e05d00] font-bold" : "absolute text-xs text-[#3b4a60] font-bold"}
        style={{ insetL: row.x, insetT: row.y + 6 }}
      >
        {row.author}
      </Text>
      <Text class={props.lit() ? "absolute text-xs text-[#d6e6ff]" : "absolute text-xs text-[#a0a6ae]"} style={{ insetL: row.x + measure(row.author, FONT.xsBold) + 6, insetT: row.y + 6 }}>
        {row.age}
      </Text>
      <For each={row.body}>
        {(line, index) => (
          <Text
            class={props.lit() ? "absolute text-xs text-white" : (row.comment?.hidden ?? 0) > 0 ? "absolute text-xs text-[#8a9099]" : "absolute text-xs text-[#222222]"}
            style={{ insetL: row.x, insetT: row.y + 22 + index() * BODY_LINE }}
          >
            {line}
          </Text>
        )}
      </For>
    </>
  );
}

export function commentsPage(env: HnEnv, _stack: NavStack, layer: LayerContext): PageSpec {
  const { model, press } = env;
  const layout = createMemo(() => threadRows(env));
  const visible = createMemo(() => layout().rows.filter((row) => near(row.y, row.h, layer.offset())));
  const story = () => {
    const thread = model.thread();
    return thread ? model.client.cached(thread.story) : undefined;
  };
  createEffect(() => {
    const focused = layer.focus();
    if (focused.startsWith("comment.")) env.select(Number(focused.slice("comment.".length)));
  });
  const tap = (row: CommentRow) => {
    if (env.selected() === row.id) model.toggle(row.id);
    else env.select(row.id);
  };
  const content: PageContent = {
    view: () => (
      <>
        <Show when={layout().header}>
          {(header) => (
            <>
              <View class="absolute left-0 w-[320] bg-[#f6f6ef]" style={{ insetT: 0, height: header().h }} />
              <View class="absolute left-0 w-[320] h-[1] bg-[#e2dccb]" style={{ insetT: header().h - 1 }} />
              <For each={header().title}>
                {(line, index) => <Text class="absolute left-[12] text-base text-black font-bold" style={{ insetT: 8 + index() * 19 }}>{line}</Text>}
              </For>
              <Text class="absolute left-[12] text-xs text-[#828282]" style={{ insetT: 10 + header().title.length * 19 }}>{header().meta}</Text>
            </>
          )}
        </Show>
        <For each={visible()}>
          {(row) => (
            <CommentRowView
              row={row}
              lit={() => press.is(`comment.${row.id}`) || (env.keys() && layer.focus() === `comment.${row.id}`)}
              selected={() => env.selected() === row.id}
            />
          )}
        </For>
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
    focusOrder: () => layout().rows.map((row) => `comment.${row.id}`),
    targets(top, offset, bottom) {
      const out: Target[] = [];
      for (const row of layout().rows) {
        const y = top + row.y - offset;
        if (y + row.h <= top || y >= bottom) continue;
        out.push({ id: `comment.${row.id}`, x: 0, y, w: W, h: row.h, run: () => tap(row), hold: () => model.toggle(row.id) });
      }
      return out;
    },
    span(id) {
      const row = layout().rows.find((entry) => `comment.${entry.id}` === id);
      return row ? [row.y, row.y + row.h] : null;
    },
    activate(id) {
      const row = layout().rows.find((entry) => `comment.${entry.id}` === id);
      if (row) model.toggle(row.id);
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
      if (pressed & BTN.TRIANGLE) {
        const thread = model.thread();
        if (thread) model.openThread(thread.story);
        return true;
      }
      return false;
    },
  };
}

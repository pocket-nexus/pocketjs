// The compact controls: a focus list, value rows that adjust in place, a
// one-line text field for a hardware keyboard, an action pad, a progress
// bar, a detail block and a panel. Every control is absolutely placed in
// the box its props name, draws its focus as the accent bar and wash, and
// leaves input to the hooks beside it (`useListNav`, `useValueRows`,
// `useActionPad`): a scene composes the two.

import { createEffect, createMemo, createSignal, For, Index, Show, untrack, type Accessor, type JSX } from "solid-js";
import { ENUMS } from "../../../contracts/spec/spec.ts";
import { after } from "../clock.ts";
import { Image, Text, View } from "../primitives.ts";
import type { NodeMirror } from "../renderer.ts";
import { useKey, useNav } from "./app.tsx";
import type { NavEvent } from "./input.ts";
import { bump, createFollower, flip, glide, MOTION, place, pop, SECTION_SHIFT, slideFrom, type Rect } from "./motion.ts";
import { ellipsize, measure } from "./text.ts";
import { BUTTON_H, COLOR, CONTENT_W, FOCUS_BAR_W, GUTTER, LINE, RADIUS, ROW_GAP, ROW_H, SLOT, TONE_COLOR, type Tone } from "./tokens.ts";

export interface Box {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/** The `display` style of a node kept in the tree while it is hidden (an
 *  Image bound to a texture, a node a later move needs). */
export const display = (shown: boolean): number => (shown ? ENUMS.Display.Flex : ENUMS.Display.None);

function box(props: Box, defaults: Required<Box>): Required<Box> {
  return { x: props.x ?? defaults.x, y: props.y ?? defaults.y, w: props.w ?? defaults.w, h: props.h ?? defaults.h };
}

// ---- selection ------------------------------------------------------------------

export { createSelection, stepValue, cycle, type Selection } from "./select.ts";
import { type Selection } from "./select.ts";

export interface ListNavOptions {
  onOk?: (index: number) => void;
  onBack?: () => void;
  /** Left and right as page moves of this many rows (default: unused). */
  page?: number;
  /** Other keys of the scene. */
  other?: (event: NavEvent) => boolean | void;
}

/** Up and down move the selection; ok acts on it. */
export function useListNav(selection: Selection, options: ListNavOptions = {}): void {
  useNav(event => {
    switch (event.key) {
      case "up":
        selection.move(-1);
        return true;
      case "down":
        selection.move(1);
        return true;
      case "left":
        if (options.page) {
          selection.move(-options.page);
          return true;
        }
        break;
      case "right":
        if (options.page) {
          selection.move(options.page);
          return true;
        }
        break;
      case "ok":
        options.onOk?.(selection.index());
        return true;
      case "back":
        if (options.onBack) {
          options.onBack();
          return true;
        }
        break;
    }
    return options.other?.(event);
  });
}

// ---- list ----------------------------------------------------------------------

export interface ListProps<T> extends Box {
  items: Accessor<readonly T[]>;
  selection: Selection;
  label: (item: T) => string;
  /** A second, dimmer line; rows grow to hold it. */
  detail?: (item: T) => string;
  /** Right-aligned value on the first line. */
  value?: (item: T) => string;
  /** A dot before the label. */
  dot?: (item: T) => Tone | null;
  /** Shown when the list is empty. */
  empty?: string;
  rowHeight?: number;
}

/** A vertical list with one focused row: the wash, the accent bar at the
 *  left, bold label, dim detail. When the focus passes the view's edge the
 *  rows glide to bring it in; the cursor glides between rows. Rows are
 *  mounted one view beyond each edge, so a row the scroll brings in is
 *  drawn before it arrives. */
export function List<T>(props: ListProps<T>): JSX.Element {
  const b = () => box(props, { x: GUTTER, y: 0, w: CONTENT_W, h: 136 });
  const rowHeight = props.rowHeight ?? (props.detail ? ROW_H + 8 : ROW_H);
  const stride = rowHeight + ROW_GAP;
  const visible = () => Math.max(1, Math.floor(b().h / stride));
  const [first, setFirst] = createSignal(0);
  createMemo(() => {
    const index = props.selection.index();
    const start = first();
    if (index < start) setFirst(index);
    else if (index >= start + visible()) setFirst(index - visible() + 1);
    const count = props.items().length;
    if (first() > Math.max(0, count - visible())) setFirst(Math.max(0, count - visible()));
  });
  const total = () => props.items().length;
  const scrolls = () => total() > visible();
  const rowW = () => b().w - (scrolls() ? 4 : 0);
  const from = () => Math.max(0, first() - visible());
  const shown = createMemo(() => props.items().slice(from(), Math.min(total(), first() + 2 * visible())));
  const barHeight = () => Math.max(6, Math.round((visible() / Math.max(visible(), total())) * b().h));
  const barTop = () => Math.round((first() / Math.max(1, total())) * b().h);
  let content: NodeMirror | undefined;
  let cursor: NodeMirror | undefined;
  let thumb: NodeMirror | undefined;
  const followScroll = createFollower("translateY", MOTION.scroll);
  const followCursor = createFollower("translateY", MOTION.focus);
  const followThumb = createFollower("translateY", MOTION.scroll);
  createEffect(() => followScroll(content, -first() * stride));
  createEffect(() => followCursor(cursor, props.selection.index() * stride));
  createEffect(() => followThumb(thumb, barTop()));
  return (
    <View class="absolute overflow-hidden" style={{ insetL: b().x, insetT: b().y, width: b().w, height: b().h }}>
      <Show when={total() === 0 && props.empty}>
        <Text class="absolute text-xs leading-[14] text-[#8e80ac]" style={{ insetL: FOCUS_BAR_W + 6, insetT: 4 }}>
          {props.empty}
        </Text>
      </Show>
      <View ref={node => (content = node)} class="absolute left-0 top-0" style={{ width: rowW(), height: Math.max(b().h, total() * stride) }}>
        <View ref={node => (cursor = node)} class="absolute left-0 top-0 rounded-sm bg-[#2b2148]" style={{ width: rowW(), height: rowHeight, display: total() === 0 ? ENUMS.Display.None : ENUMS.Display.Flex }}>
          <View class="absolute left-0 top-0 rounded-sm bg-[#ffd23f]" style={{ width: FOCUS_BAR_W, height: rowHeight }} />
        </View>
        <Index each={shown()}>
          {(item, k) => {
            const index = () => from() + k;
            const focused = () => props.selection.index() === index();
            const labelWidth = () => rowW() - 14 - (props.value ? Math.ceil(measure(props.value!(item()), SLOT.xs)) + 10 : 0);
            return (
              <View class="absolute left-0" style={{ insetT: index() * stride, width: rowW(), height: rowHeight }}>
                <Show when={props.dot?.(item())}>
                  {tone => <View class="absolute w-[5] h-[5] rounded-full" style={{ insetL: 7, insetT: 8, bgColor: TONE_COLOR[tone()] }} />}
                </Show>
                <Text class="absolute text-sm font-bold leading-[22]" style={{ insetL: props.dot ? 16 : 8, insetT: 0, textColor: focused() ? COLOR.ink : COLOR.text }}>
                  {ellipsize(props.label(item()), SLOT.smBold, labelWidth())}
                </Text>
                <Show when={props.value}>
                  {value => {
                    const text = () => value()(item());
                    const width = () => Math.ceil(measure(text(), SLOT.xs));
                    return (
                      <Text class="absolute text-xs leading-[22] text-[#a99cc6]" style={{ insetL: rowW() - 6 - width(), insetT: 0 }}>
                        {text()}
                      </Text>
                    );
                  }}
                </Show>
                <Show when={props.detail}>
                  {detail => (
                    <Text class="absolute text-2xs leading-[12] text-[#8e80ac]" style={{ insetL: props.dot ? 16 : 8, insetT: 17 }}>
                      {ellipsize(detail()(item()), SLOT.tiny, rowW() - 14)}
                    </Text>
                  )}
                </Show>
              </View>
            );
          }}
        </Index>
      </View>
      <Show when={scrolls()}>
        <View class="absolute w-[2] bg-[#2b2148]" style={{ insetL: b().w - 2, insetT: 0, height: b().h }} />
        <View ref={node => (thumb = node)} class="absolute top-0 w-[2] bg-[#8e80ac]" style={{ insetL: b().w - 2, height: barHeight() }} />
      </Show>
    </View>
  );
}

// ---- value rows -------------------------------------------------------------------

export interface ValueRow {
  label: string;
  /** The current value as text; "" draws none. */
  value: () => string;
  /** Left and right change the value; `fine` is Shift held. */
  adjust?: (direction: -1 | 1, fine: boolean) => void;
  /** Ok on the row. */
  press?: () => void;
  /** The value's tone (default ink). */
  tone?: () => Tone;
  /** The row is read-only. */
  disabled?: boolean;
}

export interface ValueRowsProps extends Box {
  rows: Accessor<readonly ValueRow[]>;
  selection: Selection;
}

/** Rows of label and value: a focused row that adjusts shows chevrons round
 *  its value. The cursor glides between rows, and the rows glide when the
 *  focus passes the view's edge. */
export function ValueRows(props: ValueRowsProps): JSX.Element {
  const b = () => box(props, { x: GUTTER, y: 0, w: CONTENT_W, h: 136 });
  const stride = ROW_H + ROW_GAP;
  const visible = () => Math.max(1, Math.floor(b().h / stride));
  const [first, setFirst] = createSignal(0);
  createMemo(() => {
    const index = props.selection.index();
    if (index < first()) setFirst(index);
    else if (index >= first() + visible()) setFirst(index - visible() + 1);
  });
  let content: NodeMirror | undefined;
  let cursor: NodeMirror | undefined;
  const followScroll = createFollower("translateY", MOTION.scroll);
  const followCursor = createFollower("translateY", MOTION.focus);
  createEffect(() => followScroll(content, -first() * stride));
  createEffect(() => followCursor(cursor, props.selection.index() * stride));
  return (
    <View class="absolute overflow-hidden" style={{ insetL: b().x, insetT: b().y, width: b().w, height: b().h }}>
      <View ref={node => (content = node)} class="absolute left-0 top-0" style={{ width: b().w, height: Math.max(b().h, props.rows().length * stride) }}>
        <View ref={node => (cursor = node)} class="absolute left-0 top-0 rounded-sm bg-[#2b2148]" style={{ width: b().w, height: ROW_H, display: props.rows().length === 0 ? ENUMS.Display.None : ENUMS.Display.Flex }}>
          <View class="absolute left-0 top-0 rounded-sm bg-[#ffd23f]" style={{ width: FOCUS_BAR_W, height: ROW_H }} />
        </View>
        <For each={props.rows()}>
          {(row, i) => {
            const focused = () => props.selection.index() === i();
            const text = () => row.value();
            const width = () => Math.ceil(measure(text(), SLOT.xsBold));
            const chevrons = () => focused() && !!row.adjust && !row.disabled;
            const tone = () => (row.disabled ? COLOR.dim : TONE_COLOR[row.tone?.() ?? "ink"]);
            return (
              <View class="absolute left-0" style={{ insetT: i() * stride, width: b().w, height: ROW_H }}>
                <Text class="absolute text-sm leading-[22]" style={{ insetL: 8, insetT: 0, textColor: row.disabled ? COLOR.dim : focused() ? COLOR.ink : COLOR.text }}>
                  {row.label}
                </Text>
                <Show when={chevrons()}>
                  <Text class="absolute text-xs font-bold leading-[22] text-[#ffd23f]" style={{ insetL: b().w - 6 - width() - 24, insetT: 0 }}>
                    {"<"}
                  </Text>
                  <Text class="absolute text-xs font-bold leading-[22] text-[#ffd23f]" style={{ insetL: b().w - 6 - 8, insetT: 0 }}>
                    {">"}
                  </Text>
                </Show>
                <Text class="absolute text-xs font-bold leading-[22]" style={{ insetL: b().w - 6 - width() - (chevrons() ? 12 : 0), insetT: 0, textColor: focused() && !row.disabled ? (row.adjust ? COLOR.accent : tone()) : tone() }}>
                  {text()}
                </Text>
              </View>
            );
          }}
        </For>
      </View>
    </View>
  );
}

/** Up and down move between rows, left and right adjust the focused row,
 *  ok presses it. */
export function useValueRows(rows: Accessor<readonly ValueRow[]>, selection: Selection, options: { onBack?: () => void; other?: (event: NavEvent) => boolean | void } = {}): void {
  useNav(event => {
    const row = rows()[selection.index()];
    switch (event.key) {
      case "up":
        selection.move(-1);
        return true;
      case "down":
        selection.move(1);
        return true;
      case "left":
        if (row && !row.disabled) row.adjust?.(-1, event.fine);
        return true;
      case "right":
        if (row && !row.disabled) row.adjust?.(1, event.fine);
        return true;
      case "ok":
        if (row && !row.disabled) {
          if (row.press) row.press();
          else row.adjust?.(1, event.fine);
        }
        return true;
      case "back":
        if (options.onBack) {
          options.onBack();
          return true;
        }
        break;
    }
    return options.other?.(event);
  });
}

// ---- text field ---------------------------------------------------------------------

export interface TextFieldProps extends Box {
  value: Accessor<string>;
  /** The field reads the keyboard while true. */
  active: Accessor<boolean>;
  placeholder?: string;
  /** Characters this field accepts; default: printable ASCII. */
  accept?: (ch: string) => boolean;
  maxLength?: number;
  onInput: (value: string) => void;
  onSubmit?: (value: string) => void;
  onCancel?: () => void;
}

/** One line typed on the hardware keyboard: characters append, Backspace
 *  deletes, Enter submits, Escape cancels. The caret blinks twice a second. */
export function TextField(props: TextFieldProps): JSX.Element {
  const b = () => box(props, { x: GUTTER, y: 0, w: CONTENT_W, h: BUTTON_H + 2 });
  const [blink, setBlink] = createSignal(true);
  const tick = () => {
    setBlink(v => !v);
    after(0.5, tick);
  };
  after(0.5, tick);
  const accept = props.accept ?? ((ch: string) => ch.length === 1 && ch >= " " && ch <= "~");
  useKey(event => {
    if (!props.active()) return;
    if (event.kind === "commit") {
      const text = [...event.text].filter(accept).join("");
      props.onInput((props.value() + text).slice(0, props.maxLength ?? 64));
      return true;
    }
    if (event.kind !== "key") return;
    const key = event.key;
    if (!event.pressed) return key !== "Shift";
    if (key === "Enter") {
      props.onSubmit?.(props.value());
      return true;
    }
    if (key === "Escape") {
      props.onCancel?.();
      return true;
    }
    if (key === "Backspace") {
      props.onInput(props.value().slice(0, -1));
      return true;
    }
    if (key === "Control+u") {
      props.onInput("");
      return true;
    }
    if (accept(key)) {
      if (props.value().length < (props.maxLength ?? 64)) props.onInput(props.value() + key);
      return true;
    }
    // Modifiers and unknown editing keys stay with the field while it types.
    return key === "Shift" || key === "Fn" || key === "CapsLock" || key.includes("Arrow") || key === "Tab";
  });
  const showPlaceholder = () => props.value().length === 0 && !!props.placeholder;
  const textWidth = () => Math.ceil(measure(props.value(), SLOT.xs));
  return (
    <View class="absolute rounded-sm bg-[#231b3b] border" style={{ insetL: b().x, insetT: b().y, width: b().w, height: b().h, borderColor: props.active() ? COLOR.accent : COLOR.line }}>
      <Text class="absolute text-xs leading-[18]" style={{ insetL: 6, insetT: 1, textColor: showPlaceholder() ? COLOR.dim : COLOR.ink }}>
        {showPlaceholder() ? props.placeholder : ellipsize(props.value(), SLOT.xs, b().w - 16)}
      </Text>
      <Show when={props.active() && blink()}>
        <View class="absolute w-[1] bg-[#ffd23f]" style={{ insetL: 6 + (showPlaceholder() ? 0 : Math.min(textWidth(), b().w - 16)) + 1, insetT: 4, height: b().h - 8 }} />
      </Show>
    </View>
  );
}

// ---- progress and panels -----------------------------------------------------------------

export interface ProgressProps extends Box {
  value: Accessor<number>;
  tone?: Tone;
}

export function Progress(props: ProgressProps): JSX.Element {
  const b = () => box(props, { x: GUTTER, y: 0, w: CONTENT_W, h: 6 });
  const fill = () => Math.round(Math.max(0, Math.min(1, props.value())) * b().w);
  let bar: NodeMirror | undefined;
  const follow = createFollower("width", MOTION.value);
  createEffect(() => follow(bar, fill()));
  return (
    <View class="absolute rounded-sm bg-[#2b2148]" style={{ insetL: b().x, insetT: b().y, width: b().w, height: b().h }}>
      <View ref={node => (bar = node)} class="absolute left-0 top-0 rounded-sm" style={{ height: b().h, bgColor: TONE_COLOR[props.tone ?? "ok"] }} />
    </View>
  );
}

export interface PanelProps extends Box {
  title?: string;
  children?: JSX.Element;
  raised?: boolean;
}

/** A rounded box; children are placed inside it. */
export function Panel(props: PanelProps): JSX.Element {
  const b = () => box(props, { x: GUTTER, y: 0, w: CONTENT_W, h: 60 });
  return (
    <View class="absolute rounded-md border" style={{ insetL: b().x, insetT: b().y, width: b().w, height: b().h, bgColor: props.raised ? COLOR.raised : COLOR.panel, borderColor: COLOR.line }}>
      <Show when={props.title}>
        <Text class="absolute text-2xs font-bold leading-[12] text-[#8e80ac]" style={{ insetL: 6, insetT: 3 }}>
          {props.title}
        </Text>
      </Show>
      {props.children}
    </View>
  );
}

/** A short state word in a small rounded tag: LIVE, FROZEN, REC. */
export function Chip(props: { text: () => string; tone?: () => Tone; x: number; y: number }): JSX.Element {
  const width = () => Math.ceil(measure(props.text(), SLOT.tinyBold)) + 8;
  const tone = () => TONE_COLOR[props.tone?.() ?? "dim"];
  return (
    <View class="absolute rounded-sm border" style={{ insetL: props.x, insetT: props.y, width: width(), height: 12, borderColor: tone() }}>
      <Text class="absolute left-0 top-0 text-2xs font-bold leading-[11] text-center" style={{ width: width(), textColor: tone() }}>
        {props.text()}
      </Text>
    </View>
  );
}

/** Dim label and ink value on one line. */
export function KeyValue(props: { label: string; value: () => string; x: number; y: number; w: number; tone?: () => Tone }): JSX.Element {
  const width = () => Math.ceil(measure(props.value(), SLOT.xs));
  return (
    <View class="absolute" style={{ insetL: props.x, insetT: props.y, width: props.w, height: LINE.xs }}>
      <Text class="absolute left-0 top-0 text-2xs leading-[14] text-[#8e80ac]">{props.label}</Text>
      <Text class="absolute top-0 text-xs leading-[14]" style={{ insetL: props.w - width(), textColor: TONE_COLOR[props.tone?.() ?? "ink"] }}>
        {props.value()}
      </Text>
    </View>
  );
}

// ---- action pad ----------------------------------------------------------------------------

export interface PadAction {
  label: string;
  /** A second, smaller line. */
  sub?: string;
  press: () => void;
  tone?: Tone;
  disabled?: boolean;
}

export interface ActionPadProps extends Box {
  actions: Accessor<readonly PadAction[]>;
  columns: number;
  selection: Selection;
  gap?: number;
}

/** A grid of buttons; the focused one is filled with the accent. */
export function ActionPad(props: ActionPadProps): JSX.Element {
  const b = () => box(props, { x: GUTTER, y: 0, w: CONTENT_W, h: 136 });
  const gap = props.gap ?? 4;
  const rows = () => Math.max(1, Math.ceil(props.actions().length / props.columns));
  const cellW = () => Math.floor((b().w - gap * (props.columns - 1)) / props.columns);
  const cellH = () => Math.floor((b().h - gap * (rows() - 1)) / rows());
  return (
    <View class="absolute" style={{ insetL: b().x, insetT: b().y, width: b().w, height: b().h }}>
      <Index each={props.actions()}>
        {(action, i) => {
          const focused = () => props.selection.index() === i;
          const col = i % props.columns;
          const row = Math.floor(i / props.columns);
          const tone = () => (action().disabled ? COLOR.dim : TONE_COLOR[action().tone ?? "ink"]);
          // The fill crosses to the focused cell: bg and label colours tween.
          let cell: NodeMirror | undefined;
          let label: NodeMirror | undefined;
          const fillColor = createFollower("bgColor", MOTION.focus);
          const edgeColor = createFollower("borderColor", MOTION.focus);
          const labelColor = createFollower("textColor", MOTION.focus);
          createEffect(() => {
            fillColor(cell, focused() ? COLOR.accent : COLOR.panel);
            edgeColor(cell, focused() ? COLOR.accent : COLOR.line);
            labelColor(label, focused() ? COLOR.accentInk : tone());
          });
          // A press dips the focused cell.
          let presses = props.selection.pressed();
          createEffect(() => {
            const now = props.selection.pressed();
            if (now !== presses && untrack(focused) && cell) bump(cell);
            presses = now;
          });
          return (
            <View ref={node => (cell = node)} class="absolute rounded-md border" style={{ insetL: col * (cellW() + gap), insetT: row * (cellH() + gap), width: cellW(), height: cellH() }}>
              <Text ref={node => (label = node)} class="absolute left-0 text-sm font-bold text-center" style={{ width: cellW(), insetT: action().sub ? Math.max(2, (cellH() - 30) / 2) : (cellH() - 16) / 2, lineHeight: 16 }}>
                {action().label}
              </Text>
              <Show when={action().sub}>
                <Text class="absolute left-0 text-2xs leading-[12] text-center" style={{ width: cellW(), insetT: Math.max(2, (cellH() - 30) / 2) + 17, textColor: focused() ? COLOR.accentInk : COLOR.dim }}>
                  {action().sub}
                </Text>
              </Show>
            </View>
          );
        }}
      </Index>
    </View>
  );
}

/** Directions move through the grid, ok presses the focused action. */
export function useActionPad(actions: Accessor<readonly PadAction[]>, columns: number, selection: Selection, options: { onBack?: () => void; other?: (event: NavEvent) => boolean | void } = {}): void {
  useNav(event => {
    const count = actions().length;
    const at = selection.index();
    switch (event.key) {
      case "left":
        if (at % columns > 0) selection.set(at - 1);
        return true;
      case "right":
        if (at % columns < columns - 1 && at + 1 < count) selection.set(at + 1);
        return true;
      case "up":
        if (at - columns >= 0) selection.set(at - columns);
        return true;
      case "down":
        if (at + columns < count) selection.set(at + columns);
        return true;
      case "ok": {
        const action = actions()[at];
        if (action && !action.disabled) {
          selection.press();
          action.press();
        }
        return true;
      }
      case "back":
        if (options.onBack) {
          options.onBack();
          return true;
        }
        break;
    }
    return options.other?.(event);
  });
}

// ---- section tabs ----------------------------------------------------------------------

export interface SectionTabsProps {
  items: readonly string[];
  active: Accessor<number>;
  x?: number;
  y?: number;
}

/** The names of a scene's sections in a row; the accent highlight glides to
 *  the active one. Left and right switch them. */
export function SectionTabs(props: SectionTabsProps): JSX.Element {
  const x0 = props.x ?? GUTTER;
  const y = props.y ?? 3;
  let x = 0;
  const placed = props.items.map(item => {
    const w = Math.ceil(measure(item, SLOT.tinyBold)) + 10;
    const at = x;
    x += w + 4;
    return { item, x: at, w };
  });
  let highlight: NodeMirror | undefined;
  const followX = createFollower("translateX", MOTION.section);
  const followW = createFollower("width", MOTION.section);
  createEffect(() => {
    const tab = placed[Math.max(0, Math.min(props.active(), placed.length - 1))];
    if (!tab) return;
    followX(highlight, tab.x);
    followW(highlight, tab.w);
  });
  return (
    <View class="absolute h-[12]" style={{ insetL: x0, insetT: y, width: x }}>
      <Index each={placed}>
        {tab => <View class="absolute top-0 rounded-sm bg-[#231b3b]" style={{ insetL: tab().x, width: tab().w, height: 12 }} />}
      </Index>
      <View ref={node => (highlight = node)} class="absolute left-0 top-0 h-[12] rounded-sm bg-[#ffd23f]" />
      <Index each={placed}>
        {(tab, i) => (
          <Text class="absolute top-0 text-2xs font-bold leading-[12] text-center" style={{ insetL: tab().x, width: tab().w, textColor: props.active() === i ? COLOR.accentInk : COLOR.dim }}>
            {tab().item}
          </Text>
        )}
      </Index>
    </View>
  );
}

export interface SectionBodyProps {
  /** The active section, as `SectionTabs` shows it. */
  active: Accessor<number>;
  /** How many sections there are: a step from the last to the first is a
   *  step forward. */
  count: number;
  children: JSX.Element;
}

/** The content of a scene's sections: when the active section changes the
 *  new content slides in from the side its tab lies on, while the tab's
 *  highlight glides. */
export function SectionBody(props: SectionBodyProps): JSX.Element {
  let node: NodeMirror | undefined;
  let previous = props.active();
  createEffect(() => {
    const now = props.active();
    if (node && now !== previous) {
      const n = Math.max(1, props.count);
      const forward = (now - previous + n) % n <= n / 2;
      slideFrom(node, "translateX", forward ? SECTION_SHIFT : -SECTION_SHIFT, MOTION.section);
    }
    previous = now;
  });
  return (
    <View ref={n => (node = n)} class="absolute left-0 top-0 w-[320] h-[136]">
      {props.children}
    </View>
  );
}

// ---- app grid ----------------------------------------------------------------------------

export { type GridTile } from "./select.ts";
import type { GridSize, GridTile } from "./select.ts";

export { layoutTiles, gridMetrics, GRID, GRID_SIZES, type GridLayout, type GridMetrics, type GridSize, type PlacedTile } from "./select.ts";
import { layoutTiles, gridMetrics, GRID } from "./select.ts";

/** The scrollbar's lane at the grid's right edge. */
const GRID_BAR_W = 4;

const moved = (a: Rect, b: Rect) => a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h;

export interface AppGridProps extends Box {
  tiles: Accessor<readonly GridTile[]>;
  selection: Selection;
  /** One of `GRID_SIZES`; medium when omitted. */
  size?: Accessor<GridSize>;
  empty?: string;
}

/** Apps as tiles in fixed columns, scrolling down as they grow: an icon, a
 *  label and one live value each. One cursor (the wash and the accent edge)
 *  glides to the focused tile and the rows glide to keep it in view;
 *  nothing pages sideways. When the layout changes (another size, a filter)
 *  every tile that stays glides and scales from where it was to where it
 *  now belongs, a tile that arrives grows into place, and the cursor
 *  follows. Tiles keep their place in the tree by identity: pass the same
 *  `GridTile` objects for the same apps across layouts. */
export function AppGrid(props: AppGridProps): JSX.Element {
  const b = () => box(props, { x: GUTTER, y: 0, w: CONTENT_W, h: 120 });
  const size = () => props.size?.() ?? GRID;
  const metrics = createMemo(() => gridMetrics(size(), b().w - GRID_BAR_W));
  const cellW = () => metrics().cellW;
  const cellH = () => metrics().cellH;
  const layout = createMemo(() => layoutTiles(props.tiles(), metrics()));
  const placedOf = createMemo(() => new Map(layout().tiles.map(placed => [placed.tile, placed])));
  // Tiles mounted while the grid first draws appear in place; later ones grow in.
  let settled = false;
  after(0, () => (settled = true));
  const [scroll, setScroll] = createSignal(0);
  // The focused tile stays in view.
  createEffect(() => {
    const placed = layout().tiles[props.selection.index()];
    if (!placed) return;
    const top = placed.y;
    const bottom = placed.y + cellH();
    let next = scroll();
    if (top < next) next = top;
    else if (bottom > next + b().h) next = bottom - b().h;
    next = Math.max(0, Math.min(next, Math.max(0, layout().height - b().h)));
    if (next !== scroll()) setScroll(next);
  });
  let outer: NodeMirror | undefined;
  let cursor: NodeMirror | undefined;
  let content: NodeMirror | undefined;
  const followX = createFollower("translateX", MOTION.focus);
  const followY = createFollower("translateY", MOTION.focus);
  const followW = createFollower("width", MOTION.focus);
  const followH = createFollower("height", MOTION.focus);
  const followScroll = createFollower("translateY", MOTION.scroll);
  // A size change moves everything over the reflow time, a step over the focus time.
  let cursorCell = 0;
  createEffect(() => {
    const placed = layout().tiles[props.selection.index()];
    if (!placed) return;
    const ms = cursorCell !== 0 && cursorCell !== cellW() ? MOTION.reflow : MOTION.focus;
    cursorCell = cellW();
    followX(cursor, placed.x, ms);
    followY(cursor, placed.y, ms);
    followW(cursor, cellW(), ms);
    followH(cursor, cellH(), ms);
  });
  let scrollCell = 0;
  createEffect(() => {
    const to = -scroll();
    const ms = scrollCell !== 0 && scrollCell !== cellW() ? MOTION.reflow : MOTION.scroll;
    scrollCell = cellW();
    followScroll(content, to, ms);
  });
  // The grid's own box moving (a search field opening above it) glides too.
  let lastY: number | null = null;
  createEffect(() => {
    const y = b().y;
    if (outer && lastY !== null && lastY !== y) {
      place(outer, "translateY", lastY - y);
      glide(outer, "translateY", 0, MOTION.focus);
    }
    lastY = y;
  });
  const total = () => layout().tiles.length;
  const barHeight = () => Math.max(6, Math.round((b().h / Math.max(b().h, layout().height)) * b().h));
  const barTop = () => Math.round((scroll() / Math.max(1, layout().height)) * b().h);
  // A large tile is 59 px: a 32 px icon, a 14 px name line and an 11 px value line.
  const iconTop = () => (size().text === "large" ? 2 : size().text === "small" ? 4 : Math.round((cellH() - size().iconSize) / 2));
  const textTop = () => iconTop() + size().iconSize + (size().text === "large" ? 1 : 2);
  return (
    <View ref={node => (outer = node)} class="absolute overflow-hidden" style={{ insetL: b().x, insetT: b().y, width: b().w, height: b().h }}>
      <Show when={total() === 0 && props.empty}>
        <Text class="absolute text-xs leading-[14] text-[#8e80ac]" style={{ insetL: 2, insetT: 4 }}>
          {props.empty}
        </Text>
      </Show>
      <View ref={node => (content = node)} class="absolute left-0 top-0" style={{ width: b().w - GRID_BAR_W, height: Math.max(b().h, layout().height) }}>
        <View ref={node => (cursor = node)} class="absolute left-0 top-0 rounded-md bg-[#2b2148] border" style={{ borderColor: COLOR.accent, display: total() === 0 ? ENUMS.Display.None : ENUMS.Display.Flex }} />
        <For each={props.tiles()}>
          {tile => {
            const placed = () => placedOf().get(tile);
            const focused = () => (placed() ? props.selection.index() === placed()!.index : false);
            const rect = (): Rect => ({ x: placed()?.x ?? 0, y: placed()?.y ?? 0, w: cellW(), h: cellH() });
            let node: NodeMirror | undefined;
            let last: Rect | null = null;
            createEffect(() => {
              if (!placed()) return;
              const next = rect();
              if (node) {
                if (last && moved(last, next)) flip(node, last, next);
                else if (!last && settled) pop(node);
              }
              last = next;
            });
            // Opening a tile dips it as its scene arrives.
            let presses = props.selection.pressed();
            createEffect(() => {
              const now = props.selection.pressed();
              if (now !== presses && untrack(focused) && node) bump(node);
              presses = now;
            });
            const icon = () => size().iconSize;
            const labelFont = () => (size().text === "large" ? SLOT.xsBold : SLOT.tinyBold);
            const labelText = () => ellipsize(tile.label, labelFont(), cellW());
            const valueText = () => ellipsize(tile.value?.() ?? "", SLOT.tiny, cellW());
            const labelW = () => Math.ceil(measure(labelText(), labelFont()));
            const valueW = () => Math.ceil(measure(valueText(), SLOT.tiny));
            const labelColor = () => (focused() ? COLOR.ink : COLOR.text);
            const valueTop = () => textTop() + (size().text === "large" ? 12 : 11);
            return (
              <View ref={n => (node = n)} class="absolute" style={{ insetL: rect().x, insetT: rect().y, width: cellW(), height: cellH() }}>
                <Image class="absolute" src={tile.icon} style={{ insetL: Math.round((cellW() - icon()) / 2), insetT: iconTop(), width: icon(), height: icon() }} />
                <Show when={size().text === "large"}>
                  <Text class="absolute text-xs font-bold leading-[14]" style={{ insetL: Math.round((cellW() - labelW()) / 2), insetT: textTop(), textColor: labelColor() }}>
                    {labelText()}
                  </Text>
                </Show>
                <Show when={size().text === "small"}>
                  <Text class="absolute text-2xs font-bold leading-[12]" style={{ insetL: Math.round((cellW() - labelW()) / 2), insetT: textTop(), textColor: labelColor() }}>
                    {labelText()}
                  </Text>
                </Show>
                <Show when={size().text !== "none" && valueText()}>
                  <Text class="absolute text-2xs leading-[11]" style={{ insetL: Math.round((cellW() - valueW()) / 2), insetT: valueTop(), textColor: TONE_COLOR[tile.tone?.() ?? "dim"] }}>
                    {valueText()}
                  </Text>
                </Show>
                <Show when={tile.dot?.()}>
                  {tone => <View class="absolute w-[5] h-[5] rounded-full" style={{ insetL: cellW() - 9, insetT: 4, bgColor: TONE_COLOR[tone()] }} />}
                </Show>
              </View>
            );
          }}
        </For>
      </View>
      <Show when={layout().height > b().h}>
        <View class="absolute w-[2] bg-[#2b2148]" style={{ insetL: b().w - 2, insetT: 0, height: b().h }} />
        <View class="absolute w-[2] bg-[#8e80ac]" style={{ insetL: b().w - 2, insetT: barTop(), height: barHeight() }} />
      </Show>
    </View>
  );
}

export interface AppGridNavOptions {
  /** The width of the `AppGrid`'s box. */
  width?: number;
  size?: Accessor<GridSize>;
  onOk?: (index: number) => void;
  other?: (event: NavEvent) => boolean | void;
}

/** Directions move through the grid: left and right along a row, up and
 *  down to the same column (the last tile when the row is short); ok opens
 *  the focused tile. */
export function useAppGrid(tiles: Accessor<readonly GridTile[]>, selection: Selection, options: AppGridNavOptions = {}): void {
  const layout = createMemo(() => layoutTiles(tiles(), gridMetrics(options.size?.() ?? GRID, (options.width ?? CONTENT_W) - GRID_BAR_W)));
  useNav(event => {
    const at = selection.index();
    const { rows, tiles } = layout();
    const placed = tiles[at];
    const current = placed ? rows[placed.row] : undefined;
    switch (event.key) {
      case "left":
        if (placed && placed.col > 0) selection.set(at - 1);
        return true;
      case "right":
        if (placed && current && placed.col + 1 < current.length) selection.set(at + 1);
        return true;
      case "up":
      case "down": {
        if (!placed) return true;
        const target = rows[placed.row + (event.key === "up" ? -1 : 1)];
        if (!target) return true;
        let best = target[0]!;
        for (const candidate of target) if (Math.abs(candidate.x - placed.x) < Math.abs(best.x - placed.x)) best = candidate;
        selection.set(best.index);
        return true;
      }
      case "ok":
        selection.press();
        options.onOk?.(at);
        return true;
    }
    return options.other?.(event);
  });
}

// ---- detail --------------------------------------------------------------------------

export interface DetailProps extends Box {
  /** The one value the block is about. */
  value: () => string;
  unit?: string;
  label?: string;
  rows?: Accessor<readonly [string, string][]>;
  tone?: () => Tone;
}

/** One large value with its unit, and a few label/value rows under it. */
export function Detail(props: DetailProps): JSX.Element {
  const b = () => box(props, { x: GUTTER, y: 0, w: CONTENT_W, h: 136 });
  const valueWidth = () => Math.ceil(measure(props.value(), SLOT.xxlBold));
  return (
    <View class="absolute" style={{ insetL: b().x, insetT: b().y, width: b().w, height: b().h }}>
      <Show when={props.label}>
        <Text class="absolute left-0 top-0 text-2xs font-bold leading-[12] text-[#8e80ac]">{props.label}</Text>
      </Show>
      <Text class="absolute left-0 text-2xl font-bold leading-[26]" style={{ insetT: props.label ? 12 : 0, textColor: TONE_COLOR[props.tone?.() ?? "ink"] }}>
        {props.value()}
      </Text>
      <Show when={props.unit}>
        <Text class="absolute text-xs leading-[14] text-[#a99cc6]" style={{ insetL: valueWidth() + 4, insetT: (props.label ? 12 : 0) + 10 }}>
          {props.unit}
        </Text>
      </Show>
      <Show when={props.rows}>
        {rows => (
          <For each={rows()()}>
            {([label, value], i) => <KeyValue label={label} value={() => value} x={0} y={(props.label ? 12 : 0) + 30 + i() * (LINE.xs + 2)} w={b().w} />}
          </For>
        )}
      </Show>
    </View>
  );
}

export { RADIUS };

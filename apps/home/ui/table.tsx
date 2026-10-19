// apps/home/ui/table.tsx — the iOS 6 grouped table: white rounded sections
// on pinstripes, embossed section headers, footers, 1 px separators, icons,
// values, chevrons, checkmarks and switches.
//
// layoutTable() turns section data into absolute offsets once; the same
// offsets place the nodes and name the hit targets, so a row is never a
// wrapper View and the tree stays two levels deep under a section.

import { createMemo, For, Show, type Accessor } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { ClassicSpinner } from "@pocketjs/framework/classic";
import { Bars, Switch, SWITCH_H, SWITCH_W, Tile, type Glyph } from "./chrome.tsx";
import { ellipsize, FONT, measure, wrap } from "./text.ts";
import type { Press, Target } from "./touch.ts";

export const ROW_H = 36;
export const ROW_DETAIL_H = 44;
const INSET = 9;
const HEADER_H = 26;
const GAP = 14;
const FOOTER_LINE = 15;

export interface CellIcon {
  glyph: Glyph;
  from: string;
  to: string;
}

export interface Cell {
  id: string;
  label: string;
  value?: string;
  /** Second line under the label (smaller, grey). */
  detail?: string;
  icon?: CellIcon;
  /** Letters tile (generated app icon) instead of a glyph tile. */
  tile?: { from: string; to: string; letters: string };
  accessory?: "chevron" | "check" | "switch" | "spinner" | "bars";
  /** Switch position or check visibility. */
  on?: boolean;
  /** Bars level for accessory "bars". */
  level?: number;
  /** "action": centered blue text; "danger": centered red text; "muted": grey label. */
  tone?: "action" | "danger" | "muted";
  /** A small pill button at the right edge with its own target. */
  button?: { id: string; label: string; tone: "red" | "grey"; run: () => void };
  run?: () => void;
}

export interface Section {
  header?: string;
  footer?: string;
  cells: Cell[];
}

export interface PlacedCell {
  cell: Cell;
  /** Offset inside its group. */
  y: number;
  h: number;
  first: boolean;
  last: boolean;
}

export interface PlacedGroup {
  key: string;
  y: number;
  h: number;
  header: string;
  headerY: number;
  footer: string[];
  footerY: number;
  cells: PlacedCell[];
}

export interface TableLayout {
  groups: PlacedGroup[];
  height: number;
  /** Stable signature: equal layouts need no remount. */
  key: string;
}

export function layoutTable(sections: readonly Section[], width: number): TableLayout {
  let y = 10;
  const groups: PlacedGroup[] = [];
  const footerW = width - INSET * 2 - 16;
  sections.forEach((section, index) => {
    if (section.header) y += HEADER_H - 6;
    const headerY = y - HEADER_H + 9;
    const cells: PlacedCell[] = [];
    let inner = 0;
    section.cells.forEach((cell, at) => {
      const h = cell.detail ? ROW_DETAIL_H : ROW_H;
      cells.push({ cell, y: inner, h, first: at === 0, last: at === section.cells.length - 1 });
      inner += h;
    });
    const footer = section.footer ? wrap(section.footer, FONT.xs, footerW, 4) : [];
    groups.push({ key: `${index}`, y, h: inner, header: section.header ?? "", headerY, footer, footerY: y + inner + 7, cells });
    y += inner + (footer.length ? 8 + footer.length * FOOTER_LINE : 0) + GAP;
  });
  return { groups, height: y + 4, key: JSON.stringify(sections, (k, v) => (typeof v === "function" ? undefined : v)) };
}

/** Hit targets of a laid-out table drawn at (0, top) scrolled by `offset`. */
export function tableTargets(layout: TableLayout, width: number, top: number, offset: number, bottom: number): Target[] {
  const out: Target[] = [];
  for (const group of layout.groups) {
    for (const placed of group.cells) {
      const y = top + group.y + placed.y - offset;
      if (y + placed.h <= top || y >= bottom) continue;
      const cell = placed.cell;
      if (cell.run || cell.accessory === "switch") {
        out.push({ id: cell.id, x: INSET, y, w: width - INSET * 2, h: placed.h, run: cell.run });
      }
      if (cell.button) {
        out.push({ id: cell.button.id, x: width - INSET - 74, y, w: 74, h: placed.h, run: cell.button.run });
      }
    }
  }
  return out;
}

/** Ids of the cells the d-pad walks, in order. */
export function focusOrder(layout: TableLayout): string[] {
  const out: string[] = [];
  for (const group of layout.groups) for (const placed of group.cells) if (placed.cell.run) out.push(placed.cell.id);
  return out;
}

/** Content y-range of a cell (for keeping the focused row in view). */
export function cellSpan(layout: TableLayout, id: string): [number, number] | null {
  for (const group of layout.groups) {
    for (const placed of group.cells) if (placed.cell.id === id) return [group.y + placed.y, group.y + placed.y + placed.h];
  }
  return null;
}

export interface TableProps {
  layout: Accessor<TableLayout>;
  width: number;
  press: Press;
  /** The d-pad focus; drawn only while `keys` is true. */
  focus: Accessor<string>;
  keys: Accessor<boolean>;
}

function CellView(props: { placed: PlacedCell; width: number; lit: Accessor<boolean>; press: Press }) {
  const cell = props.placed.cell;
  const y = props.placed.y;
  const h = props.placed.h;
  const groupW = props.width - INSET * 2;
  const iconW = cell.icon || cell.tile ? 32 : 0;
  const right = (cell.accessory === "chevron" ? 24 : cell.accessory === "check" ? 26 : cell.accessory === "switch" ? SWITCH_W + 12
    : cell.accessory === "spinner" ? 28 : cell.accessory === "bars" ? 26 : 10) + (cell.button ? 66 : 0);
  const labelX = 10 + iconW;
  const textTop = cell.detail ? y + 5 : y + (h - 18) / 2;
  const valueW = cell.value ? Math.min(Math.ceil(measure(cell.value, FONT.sm)) + 2, groupW - labelX - right - 50) : 0;
  const labelW = groupW - labelX - right - (valueW ? valueW + 8 : 0);
  const centered = cell.tone === "action" || cell.tone === "danger";
  const label = ellipsize(cell.label, FONT.smBold, centered ? groupW - 20 : labelW);
  const value = cell.value ? ellipsize(cell.value, FONT.sm, valueW) : "";
  const detail = cell.detail ? ellipsize(cell.detail, FONT.xs, groupW - labelX - right) : "";
  const buttonLit = () => (cell.button ? props.press.is(cell.button.id) : false);
  return (
    <>
      {/* highlight: a rounded piece at the group's outer corners, a square piece toward its inside */}
      <View
        class={props.lit() && (props.placed.first || props.placed.last) ? "absolute rounded-[8] bg-gradient-to-b from-[#058cf5] to-[#015ee6]" : "hidden"}
        style={{ insetL: 0, insetT: y, width: groupW, height: h }}
      />
      <View
        class={props.lit() && !(props.placed.first && props.placed.last) ? "absolute bg-gradient-to-b from-[#058cf5] to-[#015ee6]" : "hidden"}
        style={{
          insetL: 0,
          insetT: props.placed.first ? y + h / 2 : y,
          width: groupW,
          height: props.placed.first || props.placed.last ? h / 2 : h,
        }}
      />
      <Show when={!props.placed.last}>
        <View class="absolute h-[1] bg-[#d9dce0]" style={{ insetL: 0, insetT: y + h - 1, width: groupW }} />
      </Show>
      <Show when={cell.icon}>
        {(icon) => <Tile x={6} y={y + (h - 24) / 2} size={24} from={icon().from} to={icon().to} glyph={icon().glyph} />}
      </Show>
      <Show when={cell.tile}>
        {(tile) => <Tile x={6} y={y + (h - 24) / 2} size={24} from={tile().from} to={tile().to} letters={tile().letters} />}
      </Show>
      <Text
        class={cell.tone === "action"
          ? props.lit() ? "absolute text-sm text-white font-bold text-center" : "absolute text-sm text-[#385487] font-bold text-center"
          : cell.tone === "danger"
            ? props.lit() ? "absolute text-sm text-white font-bold text-center" : "absolute text-sm text-[#c4241b] font-bold text-center"
            : cell.tone === "muted"
              ? props.lit() ? "absolute text-sm text-white font-bold" : "absolute text-sm text-[#8a9099] font-bold"
              : props.lit() ? "absolute text-sm text-white font-bold" : "absolute text-sm text-black font-bold"}
        style={centered ? { insetL: 10, insetT: textTop, width: groupW - 20 } : { insetL: labelX, insetT: textTop }}
      >
        {label}
      </Text>
      <Show when={detail}>
        <Text class={props.lit() ? "absolute text-xs text-white" : "absolute text-xs text-[#6d7584]"} style={{ insetL: labelX, insetT: y + 24 }}>
          {detail}
        </Text>
      </Show>
      <Show when={value}>
        <Text
          class={props.lit() ? "absolute text-sm text-white text-right" : "absolute text-sm text-[#385487] text-right"}
          style={{ insetL: groupW - right - valueW, insetT: textTop, width: valueW }}
        >
          {value}
        </Text>
      </Show>
      <Show when={cell.accessory === "chevron"}>
        <Image class="absolute w-[12] h-[12]" src={props.lit() ? "art/chevron-white.svg" : "art/chevron.svg"} style={{ insetL: groupW - 20, insetT: y + (h - 12) / 2 }} />
      </Show>
      <Show when={cell.accessory === "check" && cell.on}>
        <Image class="absolute w-[14] h-[14]" src={props.lit() ? "art/check-white.svg" : "art/check.svg"} style={{ insetL: groupW - 24, insetT: y + (h - 14) / 2 }} />
      </Show>
      <Show when={cell.accessory === "switch"}>
        <Switch x={groupW - SWITCH_W - 8} y={y + (h - SWITCH_H) / 2} on={() => cell.on === true} />
      </Show>
      <Show when={cell.accessory === "spinner"}>
        <View class="absolute" style={{ insetL: groupW - 26, insetT: y + (h - 16) / 2 }}>
          <ClassicSpinner size={16} color={"#7a8291"} />
        </View>
      </Show>
      <Show when={cell.accessory === "bars"}>
        <Bars x={groupW - 22} y={y + (h - 10) / 2} level={() => cell.level ?? 0} white={props.lit} />
      </Show>
      <Show when={cell.button}>
        {(button) => (
          <>
            <View
              class={button().tone === "red"
                ? buttonLit()
                  ? "absolute w-[58] h-[24] rounded-[5] border border-[#6d0d08] bg-gradient-to-b from-[#a8261d] to-[#7a140e]"
                  : "absolute w-[58] h-[24] rounded-[5] border border-[#8f1a12] bg-gradient-to-b from-[#ef6a60] via-[#d9372c] to-[#c1241a]"
                : buttonLit()
                  ? "absolute w-[58] h-[24] rounded-[5] border border-[#6f7680] bg-gradient-to-b from-[#9aa1ab] to-[#bfc5cc]"
                  : "absolute w-[58] h-[24] rounded-[5] border border-[#a2a8b0] bg-gradient-to-b from-[#fdfdfd] to-[#dfe2e6]"}
              style={{ insetL: groupW - 66, insetT: y + (h - 24) / 2 }}
            />
            <Text
              class={button().tone === "red" ? "absolute text-xs text-white font-bold text-center" : "absolute text-xs text-[#4a5262] font-bold text-center"}
              style={{ insetL: groupW - 66, insetT: y + (h - 24) / 2 + 5, width: 58 }}
            >
              {button().label}
            </Text>
          </>
        )}
      </Show>
    </>
  );
}

/** The grouped table at content offset 0; the caller scrolls its parent. */
export function Table(props: TableProps) {
  const groupW = props.width - INSET * 2;
  return (
    <For each={props.layout().groups}>
      {(group) => (
        <>
          <Show when={group.header}>
            <Text class="absolute text-sm text-[#ffffffb0] font-bold" style={{ insetL: INSET + 8, insetT: group.headerY + 1 }}>{group.header}</Text>
            <Text class="absolute text-sm text-[#4c566c] font-bold" style={{ insetL: INSET + 8, insetT: group.headerY }}>{group.header}</Text>
          </Show>
          <View class="absolute rounded-[8] bg-[#ffffff90]" style={{ insetL: INSET, insetT: group.y + 1, width: groupW, height: group.h }} />
          <View
            class="absolute rounded-[8] border border-[#abb1b9] bg-white"
            style={{ insetL: INSET, insetT: group.y, width: groupW, height: group.h }}
          >
            <For each={group.cells}>
              {(placed) => (
                <CellView
                  placed={placed}
                  width={props.width}
                  press={props.press}
                  lit={() => props.press.is(placed.cell.id) || (props.keys() && props.focus() === placed.cell.id)}
                />
              )}
            </For>
          </View>
          <For each={group.footer}>
            {(line, index) => (
              <>
                <Text class="absolute text-xs text-[#ffffffb0] text-center" style={{ insetL: INSET, insetT: group.footerY + index() * FOOTER_LINE + 1, width: groupW }}>{line}</Text>
                <Text class="absolute text-xs text-[#4c566c] text-center" style={{ insetL: INSET, insetT: group.footerY + index() * FOOTER_LINE, width: groupW }}>{line}</Text>
              </>
            )}
          </For>
        </>
      )}
    </For>
  );
}

export interface TableContentOptions {
  sections: Accessor<readonly Section[]>;
  width: number;
  press: Press;
  focus: Accessor<string>;
  keys: Accessor<boolean>;
}

/** A grouped table as a navigation page's scrolling content. The layout is
 *  rebuilt only when the section data changes (functions are not compared). */
export function tableContent(options: TableContentOptions) {
  const layout = createMemo(() => layoutTable(options.sections(), options.width), undefined, {
    equals: (a, b) => a.key === b.key,
  });
  const cells = () => {
    const map = new Map<string, Cell>();
    for (const group of layout().groups) for (const placed of group.cells) map.set(placed.cell.id, placed.cell);
    return map;
  };
  return {
    view: () => <Table layout={layout} width={options.width} press={options.press} focus={options.focus} keys={options.keys} />,
    height: () => layout().height,
    focusOrder: () => focusOrder(layout()),
    targets: (top: number, offset: number, bottom: number) => tableTargets(layout(), options.width, top, offset, bottom),
    span: (id: string) => cellSpan(layout(), id),
    activate: (id: string) => cells().get(id)?.run?.(),
  };
}

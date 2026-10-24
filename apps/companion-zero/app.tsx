// Pocket Companion's own screen on the CardputerZero: the Mac app's pages
// (pages.ts) on a 320x170 panel. The sidebar lists the pages; the arrows
// move through it and the page beside it follows. Enter opens the page and
// moves to its buttons; Esc goes back. Links open on a phone from a QR code,
// and a 3DS pairs from one.
//
// The screen keeps its own selection instead of the focus walk: two columns,
// rows with several buttons and a page that scrolls under the selection are
// laid out here, in panel pixels, so the selection, the scroll and the
// blocks agree.

import { batch, createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { after } from "@pocketjs/framework/clock";
import { getOps } from "@pocketjs/framework/host";
import { BTN } from "@pocketjs/framework/input";
import { onFrame } from "@pocketjs/framework/lifecycle";
import type { NodeMirror } from "@pocketjs/framework/renderer";
import { createCompanion } from "./control.ts";
import { PAGES, pageBlocks, pageDot, type Block, type Button, type Page, type Screen, type Tone } from "./pages.ts";
import { freeQr, QR_TEXTURE, uploadQr, type QrTexture } from "./qr.ts";
import { ellipsize, measure, SLOT, toAscii, wrap } from "./text.ts";

const RAIL_W = 92;
const PAGE_X = RAIL_W + 8;
const PAGE_W = 320 - PAGE_X - 8;
const PAGE_TOP = 6;
const VIEW_H = 148;
const INDENT = 20;
const GAP = 6;
const BUTTON_H = 18;
const LINE = 14;
const SMALL_LINE = 12;
const SCROLL_STEP = 28;
/** Held arrows repeat after this many ticks, then every REPEAT_EVERY. */
const REPEAT_AFTER = 10;
const REPEAT_EVERY = 3;

interface Target {
  y: number;
  h: number;
  /** Targets in one row of buttons share it; LEFT and RIGHT stay in it. */
  row: number;
  press: () => void;
}

interface PlacedButton {
  button: Button;
  x: number;
  y: number;
  w: number;
  target: number;
}

interface Placed {
  block: Block;
  y: number;
  h: number;
  x: number;
  lines: string[];
  detail: string[];
  buttons: PlacedButton[];
  rows: { label: string; lines: string[]; y: number }[];
  target: number;
}

/** Lay a page out in panel pixels: each block's lines, size and buttons,
 *  and the targets the arrows move between. */
function layout(blocks: Block[]) {
  const placed: Placed[] = [];
  const targets: Target[] = [];
  let y = 0;
  blocks.forEach((block, index) => {
    const x = ("indent" in block && block.indent) || block.kind === "step" ? INDENT : 0;
    const width = PAGE_W - x;
    const entry: Placed = { block, y, h: 0, x, lines: [], detail: [], buttons: [], rows: [], target: -1 };
    switch (block.kind) {
      case "title":
        entry.lines = wrap(block.line, SLOT.xs, PAGE_W);
        entry.h = 18 + entry.lines.length * LINE + 2;
        break;
      case "text":
        entry.lines = wrap(block.text, block.small ? SLOT.tiny : SLOT.xs, width);
        entry.h = entry.lines.length * (block.small ? SMALL_LINE : LINE);
        break;
      case "state":
        entry.lines = wrap(block.text, SLOT.xsBold, PAGE_W - 12);
        entry.h = entry.lines.length * LINE;
        break;
      case "step":
        entry.x = 0;
        entry.lines = wrap(block.title, SLOT.xsBold, PAGE_W - INDENT);
        entry.detail = wrap(block.text, SLOT.tiny, PAGE_W - INDENT);
        entry.h = entry.lines.length * LINE + 1 + entry.detail.length * SMALL_LINE;
        break;
      case "item":
        entry.lines = wrap(block.title, SLOT.xsBold, PAGE_W - 18);
        entry.detail = wrap(block.detail, SLOT.tiny, PAGE_W - 18);
        entry.h = 6 + entry.lines.length * LINE + entry.detail.length * SMALL_LINE + 4;
        if (block.press) {
          entry.target = targets.length;
          targets.push({ y, h: entry.h, row: index * 64, press: block.press });
        }
        break;
      case "buttons": {
        let bx = 0;
        let by = 0;
        let line = 0;
        for (const button of block.buttons) {
          const w = Math.min(width, Math.ceil(measure(button.label, SLOT.xsBold)) + 14);
          if (bx > 0 && bx + w > width) {
            bx = 0;
            by += BUTTON_H + 4;
            line++;
          }
          entry.buttons.push({ button, x: bx, y: by, w, target: targets.length });
          targets.push({ y: y + by, h: BUTTON_H, row: index * 64 + line, press: button.press });
          bx += w + 6;
        }
        entry.h = by + BUTTON_H;
        break;
      }
      case "pairs": {
        let ry = 0;
        for (const [label, value] of block.rows) {
          const lines = wrap(value, SLOT.xs, PAGE_W - 60);
          entry.rows.push({ label, lines, y: ry });
          ry += lines.length * LINE + 2;
        }
        entry.h = ry - 2;
        break;
      }
      case "progress":
        entry.h = 6;
        break;
    }
    placed.push(entry);
    y += entry.h + (block.kind === "title" ? 8 : block.kind === "step" ? 4 : GAP);
  });
  return { placed, targets, height: Math.max(0, y - GAP) };
}

const TONE_TEXT: Record<Tone, string> = { ink: "#fcf6ff", dim: "#a99cc6", ok: "#3fd0e8", warn: "#ff7fb4" };

type Modal =
  | { kind: "link"; title: string; url: string }
  | { kind: "pair" }
  | { kind: "confirm"; title: string; text: string; action: string; run: () => void };

export default function CompanionScreen() {
  const companion = createCompanion();
  companion.start();

  const [pageIndex, setPageIndex] = createSignal(0);
  const [inPage, setInPage] = createSignal(false);
  const [target, setTarget] = createSignal(-1);
  const [scroll, setScroll] = createSignal(0);
  const [modal, setModal] = createSignal<Modal | null>(null);
  const [confirmChoice, setConfirmChoice] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const page = () => PAGES[pageIndex()]!.id;

  const tick = () => {
    setNow(Date.now());
    after(1, tick);
  };
  after(1, tick);

  const go = (id: Page) => {
    batch(() => {
      setPageIndex(PAGES.findIndex(entry => entry.id === id));
      setInPage(true);
      setScroll(0);
    });
    const count = view().targets.length;
    setTarget(count ? 0 : -1);
    if (count) reveal(0);
  };

  const screen: Screen = {
    go,
    link: (title, url) => setModal({ kind: "link", title, url }),
    pair: () => {
      setModal({ kind: "pair" });
      if (!companion.status()?.pairing.open) companion.openPairing();
    },
    confirm: (title, text, action, run) =>
      batch(() => {
        setConfirmChoice(0);
        setModal({ kind: "confirm", title, text, action, run });
      }),
  };

  const view = createMemo(() => layout(pageBlocks(page(), companion, screen)));
  const maxScroll = () => Math.max(0, view().height - VIEW_H);

  // A page that changes under the selection keeps it in range and in view.
  createEffect(() => {
    const { targets } = view();
    const current = target();
    if (current >= targets.length) setTarget(targets.length - 1);
    if (scroll() > maxScroll()) setScroll(maxScroll());
  });

  const reveal = (index: number) => {
    const t = view().targets[index];
    if (!t) return;
    let next = scroll();
    if (t.y + t.h + 4 <= VIEW_H) next = 0;
    else if (t.y + t.h + 4 > next + VIEW_H) next = t.y + t.h + 4 - VIEW_H;
    else if (t.y - 4 < next) next = t.y - 4;
    setScroll(Math.max(0, Math.min(maxScroll(), next)));
  };

  const scrollBy = (delta: number) => setScroll(Math.max(0, Math.min(maxScroll(), scroll() + delta)));

  // The pairing window closing while its code shows ends the modal.
  let pairingSeen = false;
  let pairedBefore = 0;
  createEffect(() => {
    const current = modal();
    const status = companion.status();
    if (current?.kind !== "pair") {
      pairingSeen = false;
      return;
    }
    if (!status) return;
    if (status.pairing.open && !pairingSeen) {
      pairingSeen = true;
      pairedBefore = status.paired.length;
    } else if (!status.pairing.open && pairingSeen) {
      setModal(null);
      if (status.paired.length > pairedBefore) go("consoles");
    }
  });

  const press = (key: number) => {
    const current = modal();
    if (current) {
      if (current.kind === "confirm") {
        if (key & (BTN.LEFT | BTN.RIGHT | BTN.UP | BTN.DOWN)) setConfirmChoice(confirmChoice() ? 0 : 1);
        else if (key & BTN.CROSS) setModal(null);
        else if (key & (BTN.START | BTN.CIRCLE)) {
          setModal(null);
          if (confirmChoice() === 1) current.run();
        }
        return;
      }
      if (key & (BTN.CROSS | BTN.START | BTN.CIRCLE | BTN.LEFT)) {
        setModal(null);
        if (current.kind === "pair" && companion.status()?.pairing.open) companion.closePairing();
      }
      return;
    }
    const { targets } = view();
    if (!inPage()) {
      if (key & BTN.UP) {
        batch(() => {
          setPageIndex(Math.max(0, pageIndex() - 1));
          setScroll(0);
          companion.clearNote();
        });
      } else if (key & BTN.DOWN) {
        batch(() => {
          setPageIndex(Math.min(PAGES.length - 1, pageIndex() + 1));
          setScroll(0);
          companion.clearNote();
        });
      } else if (key & (BTN.RIGHT | BTN.START | BTN.CIRCLE)) {
        batch(() => {
          setInPage(true);
          setTarget(targets.length ? 0 : -1);
          if (targets.length) reveal(0);
        });
      } else if (key & BTN.CROSS) {
        screen.confirm("Close this screen?", "Pocket Companion keeps running; consoles stay linked.", "Close", () => companion.quit());
      }
      return;
    }
    const at = target();
    if (key & BTN.UP) {
      if (at > 0) {
        setTarget(at - 1);
        reveal(at - 1);
      } else scrollBy(-SCROLL_STEP);
    } else if (key & BTN.DOWN) {
      if (at + 1 < targets.length) {
        setTarget(at + 1);
        reveal(at + 1);
      } else scrollBy(SCROLL_STEP);
    } else if (key & BTN.LEFT) {
      if (at > 0 && targets[at - 1]!.row === targets[at]!.row) setTarget(at - 1);
      else setInPage(false);
    } else if (key & BTN.RIGHT) {
      if (at + 1 < targets.length && targets[at + 1]!.row === targets[at]!.row) setTarget(at + 1);
    } else if (key & (BTN.START | BTN.CIRCLE)) {
      targets[at]?.press();
    } else if (key & BTN.CROSS) {
      setInPage(false);
    }
  };

  const KEYS = [BTN.UP, BTN.DOWN, BTN.LEFT, BTN.RIGHT, BTN.START, BTN.CIRCLE, BTN.CROSS];
  const REPEATS = BTN.UP | BTN.DOWN;
  let held = 0;
  let heldFor = 0;
  onFrame((buttons: number) => {
    const down = buttons & ~held;
    if (buttons & held & REPEATS) heldFor++;
    else heldFor = 0;
    held = buttons;
    for (const key of KEYS) {
      if (down & key) press(key);
      else if (key & REPEATS & buttons && heldFor > REPEAT_AFTER && (heldFor - REPEAT_AFTER) % REPEAT_EVERY === 0) press(key);
    }
  });

  const status = () => companion.status();
  const railLine = () => {
    const current = status();
    if (!current) return companion.down() ? "Not running" : "Starting";
    const linked = current.consoles;
    if (linked.length === 0) return "No console linked";
    const first = linked[0]!;
    const name = ellipsize(toAscii(first.name || first.model), SLOT.tiny, 60);
    return linked.length > 1 ? `${name} +${linked.length - 1}` : first.address === "usb" ? `${name} over USB` : `${name} linked`;
  };
  const hint = () => {
    if (modal()?.kind === "confirm") return "Arrows: choose   Enter: confirm   Esc: cancel";
    if (modal()) return "Esc: back";
    return inPage() ? "Arrows: move   Enter: choose   Esc: back" : "Arrows: pages   Enter: open";
  };

  return (
    <View class="absolute left-0 top-0 w-[320] h-[170] bg-[#171226]">
      <Rail pageIndex={pageIndex} inPage={inPage} line={railLine} dot={id => pageDot(id, companion)} />
      <View class="absolute overflow-hidden" style={{ insetL: PAGE_X, insetT: PAGE_TOP, width: PAGE_W + 6, height: VIEW_H }}>
        <View class="absolute left-0 top-0" style={{ width: PAGE_W, height: Math.max(VIEW_H, view().height), translateY: -scroll() }}>
          <For each={view().placed}>{entry => <BlockView entry={entry} selected={index => inPage() && target() === index} />}</For>
        </View>
        <Show when={maxScroll() > 0}>
          <View class="absolute w-[2] bg-[#2b2148]" style={{ insetL: PAGE_W + 3, insetT: 0, height: VIEW_H }} />
          <View
            class="absolute w-[2] bg-[#8e80ac]"
            style={{
              insetL: PAGE_W + 3,
              insetT: Math.round((scroll() / view().height) * VIEW_H),
              height: Math.max(8, Math.round((VIEW_H / view().height) * VIEW_H)),
            }}
          />
        </Show>
      </View>
      <View class="absolute h-[1] bg-[#2b2148]" style={{ insetL: PAGE_X, insetT: 157, width: PAGE_W }} />
      <Text class="absolute text-2xs leading-[12] text-[#8e80ac]" style={{ insetL: PAGE_X, insetT: 158 }}>
        {hint()}
      </Text>
      <Show when={modal()} keyed>
        {current => <ModalView modal={current} companion={companion} now={now} choice={confirmChoice} />}
      </Show>
    </View>
  );
}

function Rail(props: { pageIndex: () => number; inPage: () => boolean; line: () => string; dot: (page: Page) => Tone | null }) {
  return (
    <View class="absolute left-0 top-0 h-[170] bg-[#1c1630]" style={{ width: RAIL_W }}>
      <Text class="absolute left-[8] top-[5] text-xs font-bold leading-[14] text-[#fcf6ff]">Companion</Text>
      <Text class="absolute left-[8] top-[19] text-2xs leading-[12] text-[#8e80ac]">{props.line()}</Text>
      <For each={PAGES}>
        {(entry, index) => {
          const selected = () => props.pageIndex() === index();
          return (
            <View class="absolute left-0" style={{ insetT: 36 + index() * 16, width: RAIL_W, height: 16 }}>
              <Show when={selected()}>
                <View class={props.inPage() ? "absolute left-0 top-0 h-[16] bg-[#231b3b]" : "absolute left-0 top-0 h-[16] bg-[#2b2148]"} style={{ width: RAIL_W }} />
                <View class={props.inPage() ? "absolute left-0 top-0 w-[2] h-[16] bg-[#8e80ac]" : "absolute left-0 top-0 w-[2] h-[16] bg-[#ffd23f]"} />
              </Show>
              <Text class={selected() ? "absolute left-[8] top-0 text-xs font-bold leading-[16] text-[#fcf6ff]" : "absolute left-[8] top-0 text-xs leading-[16] text-[#cbbde2]"}>{entry.title}</Text>
              <Show when={props.dot(entry.id)}>
                {tone => <View class={tone() === "ok" ? "absolute w-[5] h-[5] rounded-full bg-[#3fd0e8]" : "absolute w-[5] h-[5] rounded-full bg-[#ff7fb4]"} style={{ insetL: RAIL_W - 11, insetT: 6 }} />}
              </Show>
            </View>
          );
        }}
      </For>
    </View>
  );
}

function BlockView(props: { entry: Placed; selected: (target: number) => boolean }) {
  const { entry } = props;
  const block = entry.block;
  const box = { insetL: entry.x, insetT: entry.y, width: PAGE_W - entry.x, height: entry.h };
  switch (block.kind) {
    case "title":
      return (
        <View class="absolute" style={box}>
          <Text class="absolute left-0 top-0 text-sm font-bold leading-[16] text-[#fcf6ff]">{block.text}</Text>
          <Text class="absolute left-0 top-[18] text-xs leading-[14] text-[#a99cc6]">{entry.lines.join("\n")}</Text>
        </View>
      );
    case "text":
      return (
        <Text
          class={block.small ? "absolute text-2xs leading-[12]" : "absolute text-xs leading-[14]"}
          style={{ insetL: entry.x, insetT: entry.y, textColor: TONE_TEXT[block.tone ?? "ink"] }}
        >
          {entry.lines.join("\n")}
        </Text>
      );
    case "state":
      return (
        <View class="absolute" style={box}>
          <View class={block.on ? "absolute left-0 top-[4] w-[6] h-[6] rounded-full bg-[#3fd0e8]" : "absolute left-0 top-[4] w-[6] h-[6] rounded-full bg-[#ff7fb4]"} />
          <Text class="absolute left-[12] top-0 text-xs font-bold leading-[14] text-[#fcf6ff]">{entry.lines.join("\n")}</Text>
        </View>
      );
    case "step":
      return (
        <View class="absolute" style={box}>
          <View class={block.done ? "absolute left-0 top-0 w-[14] h-[14] rounded-full bg-[#3fd0e8]" : "absolute left-0 top-0 w-[14] h-[14] rounded-full bg-[#ffd23f]"} />
          <Text class="absolute left-0 top-0 w-[14] text-2xs font-bold leading-[14] text-center text-[#171226]">{String(block.number)}</Text>
          <Text class="absolute top-0 text-xs font-bold leading-[14] text-[#fcf6ff]" style={{ insetL: INDENT }}>
            {entry.lines.join("\n")}
          </Text>
          <Text class="absolute text-2xs leading-[12] text-[#a99cc6]" style={{ insetL: INDENT, insetT: entry.lines.length * LINE + 1 }}>
            {entry.detail.join("\n")}
          </Text>
        </View>
      );
    case "item": {
      const selected = () => entry.target >= 0 && props.selected(entry.target);
      return (
        <View class="absolute" style={box}>
          <View class={selected() ? "absolute left-0 top-0 rounded-md bg-[#2b2148] border-[#ffd23f]" : "absolute left-0 top-0 rounded-md bg-[#231b3b] border-[#231b3b]"} style={{ width: PAGE_W - entry.x, height: entry.h }} />
          <View
            class={block.dot === "ok" ? "absolute left-[6] top-[10] w-[5] h-[5] rounded-full bg-[#3fd0e8]" : block.dot === "warn" ? "absolute left-[6] top-[10] w-[5] h-[5] rounded-full bg-[#ff7fb4]" : block.dot === "ink" ? "absolute left-[6] top-[10] w-[5] h-[5] rounded-full bg-[#cbbde2]" : "absolute left-[6] top-[10] w-[5] h-[5] rounded-full bg-[#5a4d78]"}
          />
          <Text class="absolute left-[16] top-[5] text-xs font-bold leading-[14] text-[#fcf6ff]">{entry.lines.join("\n")}</Text>
          <Text class="absolute left-[16] text-2xs leading-[12] text-[#a99cc6]" style={{ insetT: 5 + entry.lines.length * LINE }}>
            {entry.detail.join("\n")}
          </Text>
        </View>
      );
    }
    case "buttons":
      return (
        <View class="absolute" style={box}>
          <For each={entry.buttons}>
            {placed => {
              const selected = () => props.selected(placed.target);
              return (
                <View class={selected() ? "absolute rounded-md bg-[#ffd23f]" : "absolute rounded-md bg-[#2b2148]"} style={{ insetL: placed.x, insetT: placed.y, width: placed.w, height: BUTTON_H }}>
                  <Text class={selected() ? "absolute left-0 top-0 text-xs font-bold leading-[18] text-center text-[#171226]" : "absolute left-0 top-0 text-xs font-bold leading-[18] text-center text-[#fcf6ff]"} style={{ width: placed.w }}>
                    {placed.button.label}
                  </Text>
                </View>
              );
            }}
          </For>
        </View>
      );
    case "pairs":
      return (
        <View class="absolute" style={box}>
          <For each={entry.rows}>
            {row => (
              <View class="absolute left-0" style={{ insetT: row.y, width: PAGE_W, height: row.lines.length * LINE }}>
                <Text class="absolute left-0 top-0 text-2xs leading-[14] text-[#8e80ac]">{row.label}</Text>
                <Text class="absolute left-[60] top-0 text-xs leading-[14] text-[#fcf6ff]">{row.lines.join("\n")}</Text>
              </View>
            )}
          </For>
        </View>
      );
    case "progress":
      return (
        <View class="absolute rounded-sm bg-[#2b2148]" style={box}>
          <View class="absolute left-0 top-0 h-[6] rounded-sm bg-[#3fd0e8]" style={{ width: Math.round(Math.max(0, Math.min(1, block.value)) * (PAGE_W - entry.x)) }} />
        </View>
      );
  }
}

/** A QR code, `scale` panel pixels a module, on white with a quiet zone of
 *  two modules. */
function QrCode(props: { data: string; size: number }) {
  let image: NodeMirror | undefined;
  const texture = createMemo<QrTexture | null>(previous => {
    freeQr(previous ?? null);
    return uploadQr(props.data);
  });
  onCleanup(() => freeQr(texture()));
  createEffect(() => {
    const current = texture();
    if (image && current) getOps().setImage(image.id, current.handle);
  });
  const scale = () => Math.max(1, Math.floor(props.size / ((texture()?.size ?? 25) + 4)));
  const side = () => ((texture()?.size ?? 25) + 4) * scale();
  return (
    <View class="absolute left-0 top-0 rounded-sm bg-white" style={{ width: side(), height: side() }}>
      <View class="absolute overflow-hidden" style={{ insetL: 2 * scale(), insetT: 2 * scale(), width: (texture()?.size ?? 0) * scale(), height: (texture()?.size ?? 0) * scale() }}>
        <Image nodeRef={(node: NodeMirror) => (image = node)} class="absolute left-0 top-0" style={{ width: QR_TEXTURE * scale(), height: QR_TEXTURE * scale() }} />
      </View>
    </View>
  );
}

function ModalView(props: { modal: Modal; companion: ReturnType<typeof createCompanion>; now: () => number; choice: () => number }) {
  const modal = props.modal;
  if (modal.kind === "confirm") {
    const lines = wrap(modal.text, SLOT.xs, 236);
    const titleLines = wrap(modal.title, SLOT.smBold, 236);
    const height = 12 + titleLines.length * 16 + 6 + lines.length * LINE + 10 + BUTTON_H + 12;
    const cancelW = Math.ceil(measure("Cancel", SLOT.xsBold)) + 20;
    const actionW = Math.ceil(measure(modal.action, SLOT.xsBold)) + 20;
    const top = Math.round((156 - height) / 2);
    return (
      <View class="absolute left-0 top-0 w-[320] h-[170] bg-[#000000a0]">
        <View class="absolute rounded-lg bg-[#231b3b] border-[#3a2d5c]" style={{ insetL: 30, insetT: top, width: 260, height }}>
          <Text class="absolute left-[12] top-[12] text-sm font-bold leading-[16] text-[#fcf6ff]">{titleLines.join("\n")}</Text>
          <Text class="absolute left-[12] text-xs leading-[14] text-[#cbbde2]" style={{ insetT: 18 + titleLines.length * 16 }}>
            {lines.join("\n")}
          </Text>
          <View class={props.choice() === 0 ? "absolute rounded-md bg-[#ffd23f]" : "absolute rounded-md bg-[#2b2148]"} style={{ insetL: 248 - actionW - 6 - cancelW, insetT: height - 12 - BUTTON_H, width: cancelW, height: BUTTON_H }}>
            <Text class={props.choice() === 0 ? "absolute left-0 top-0 text-xs font-bold leading-[18] text-center text-[#171226]" : "absolute left-0 top-0 text-xs font-bold leading-[18] text-center text-[#fcf6ff]"} style={{ width: cancelW }}>
              Cancel
            </Text>
          </View>
          <View class={props.choice() === 1 ? "absolute rounded-md bg-[#ff7fb4]" : "absolute rounded-md bg-[#2b2148]"} style={{ insetL: 248 - actionW, insetT: height - 12 - BUTTON_H, width: actionW, height: BUTTON_H }}>
            <Text class={props.choice() === 1 ? "absolute left-0 top-0 text-xs font-bold leading-[18] text-center text-[#171226]" : "absolute left-0 top-0 text-xs font-bold leading-[18] text-center text-[#ff7fb4]"} style={{ width: actionW }}>
              {modal.action}
            </Text>
          </View>
        </View>
      </View>
    );
  }
  const pairing = () => props.companion.status()?.pairing;
  const title = modal.kind === "link" ? modal.title : "Pair a 3DS";
  const data = () => (modal.kind === "link" ? modal.url : pairing()?.open ? pairing()!.uri ?? "" : "");
  const caption = () => {
    if (modal.kind === "link") return "Scan this code with your phone to open the page.";
    if (!pairing()?.open) return props.companion.note()?.text ?? "Opening a pairing code...";
    return "On the 3DS, open Settings > Mac > Pair a Mac... and point the outer camera at this code. The code works once.";
  };
  const expires = () => {
    const at = pairing()?.expiresAt;
    if (modal.kind !== "pair" || !at) return "";
    const left = Math.max(0, Math.round((at - props.now()) / 1000));
    return `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  };
  const textX = 166;
  const textW = 320 - textX - 8;
  return (
    <View class="absolute left-0 top-0 w-[320] h-[170] bg-[#171226]">
      <View class="absolute left-[8] top-[6] w-[150] h-[150]">
        <Show when={data()}>{value => <QrCode data={value()} size={150} />}</Show>
      </View>
      <Text class="absolute top-[8] text-sm font-bold leading-[16] text-[#fcf6ff]" style={{ insetL: textX }}>
        {wrap(title, SLOT.smBold, textW).join("\n")}
      </Text>
      <Text class="absolute text-xs leading-[14] text-[#cbbde2]" style={{ insetL: textX, insetT: 8 + wrap(title, SLOT.smBold, textW).length * 16 + 6 }}>
        {wrap(caption(), SLOT.xs, textW).join("\n")}
      </Text>
      <Text class="absolute text-2xs leading-[12] text-[#8e80ac]" style={{ insetL: textX, insetT: 128 }}>
        {modal.kind === "link" ? ellipsize(modal.url.replace(/^https:\/\//, ""), SLOT.tiny, textW) : expires()}
      </Text>
      <Text class="absolute text-2xs leading-[12] text-[#8e80ac]" style={{ insetL: textX, insetT: 158 }}>
        Esc: back
      </Text>
    </View>
  );
}

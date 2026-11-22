// PocketUI ui/kit.tsx — the stock components: a pane's bar, rows, controls,
// content grounds, menus and dialogs, and the application's frame.
//
// A component here is behaviour and anatomy: which parts it is made of
// (theme.ts Part), what state each is in, what a press does. It names no
// colour, edge or font. The active theme paints the parts and, through its
// traits, arranges the ones whose place is a matter of tradition: a title
// bar or none, commands in a menu bar or a toolbar, the default button last
// or first. An application composes these and its own content and is drawn
// by any theme; ui.setTheme changes it under a running application.
//
// One rule keeps a change of theme from losing anything: what holds state
// (a scroll view, a field, a pane) is made once and stays where it is in the
// tree; only stateless chrome (a title bar, a row of buttons) is made again
// for a theme that arranges it differently.
import { createContext, createMemo, createRenderEffect, createSignal, For, mergeProps, onCleanup, Show, splitProps, untrack, useContext, type JSX } from "solid-js";
import { jump } from "../../animation.ts";
import type { Command } from "../core/commands.ts";
import { caption } from "./caption.ts";
import { useBack, useCommandCenter } from "./commands.ts";
import { element, type BoxProps, type Instance, type StackProps, type UIElement, type UINode } from "./engine.ts";
import { useUI, type UI } from "./mount.ts";
import { PANES } from "./panes.ts";
import { present, type Presentation } from "./present.ts";
import { Glyph, HStack, Scroll, Text, VStack, ZStack } from "./primitives.ts";
import type { GlyphName, Tone } from "./theme.ts";

export type { Tone } from "./theme.ts";

/** The theme's colour for a meaning, on a plain pane. A signal read. */
export function toneColor(ui: UI, tone: Tone | undefined): string {
  const c = ui.theme.color;
  return tone === undefined || tone === "plain" ? c.text : c[tone];
}

// ---------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------

/** A rule. With a `label`, the rule runs either side of it. */
export function Divider(props: { inset?: number; label?: string; tone?: Tone }): UIElement {
  return (
    <HStack padding={[0, 0, 0, props.inset ?? 0]} spacing={8}>
      <VStack grow={1} height={1} part="divider" />
      <Show when={props.label}>
        <Text role="caption" tone={props.tone ?? "faint"} lines={1}>{props.label}</Text>
        <VStack grow={1} height={1} part="divider" />
      </Show>
    </HStack>
  ) as UIElement;
}

/** A word that names what follows: a group inside a card. Set as the theme sets a heading (capitals or not). */
export function Label(props: { children: string; tone?: Tone }): UIElement {
  const ui = useUI();
  return (<Text role="caption" tone={props.tone ?? "muted"} lines={1}>{ui.theme.traits.sectionCaps ? props.children.toUpperCase() : props.children}</Text>) as UIElement;
}

/** A dot that says a state by its colour; `pulse` while that state is work in progress. */
export function StatusDot(props: { tone: Tone; pulse?: boolean; size?: number }): UIElement {
  const ui = useUI();
  let dot: Instance | undefined;
  const hook = () => {
    if (!dot?.placed) return;
    // a triangle wave over 64 frames, quantised: a paint-only prop, no layout
    const phase = ui.frame() % 64;
    const level = props.pulse ? 0.35 + 0.65 * (Math.abs(32 - phase) / 32) : 1;
    jump(dot.node, "opacity", Math.round(level * 8) / 8);
  };
  ui.root.frameHooks.add(hook);
  onCleanup(() => ui.root.frameHooks.delete(hook));
  // the tone's ink where the dot sits: on a selected row it is that row's, not the pane's
  const [ink, setInk] = createSignal(toneColor(ui, props.tone));
  return (
    <VStack
      width={props.size ?? 8}
      height={props.size ?? 8}
      radius={(props.size ?? 8) / 2}
      background={ink()}
      ref={(instance) => {
        dot = instance;
        createRenderEffect(() => setInk(instance.inkFor(props.tone)));
      }}
    />
  ) as UIElement;
}

/** A short label on a ground of its own: a state, a count, a kind. */
export function Badge(props: { label: string; tone?: Tone }): UIElement {
  return (
    <HStack part="badge" tone={props.tone ?? "muted"} alignSelf="center">
      <Text lines={1} tone={props.tone ?? "muted"}>{props.label}</Text>
    </HStack>
  ) as UIElement;
}

export interface ButtonProps extends BoxProps {
  label: string;
  /** `filled` is the one thing to do here; `tinted` is another thing to do; `plain` sits in a bar or a row; `pill` floats over content */
  kind?: "filled" | "plain" | "tinted" | "pill";
  /** what precedes the label: a status dot, a mark */
  leading?: UINode;
}

export function Button(props: ButtonProps): UIElement {
  const ui = useUI();
  const [own, box] = splitProps(props, ["label", "kind", "leading"]);
  return (
    <HStack
      {...mergeProps(
        {
          get minHeight() {
            return ui.metric().control;
          },
          // push buttons in a row read as a set: none is narrower than the theme's least
          get minWidth() {
            return own.kind === "plain" || own.kind === "pill" ? undefined : ui.metric().buttonMin;
          },
          justify: "center" as const,
          spacing: 6,
        },
        box,
      )}
      part="button"
      variant={own.kind ?? "tinted"}
    >
      {own.leading}
      <Text lines={1}>{own.label}</Text>
    </HStack>
  ) as UIElement;
}

// ---------------------------------------------------------------------------
// Content grounds
// ---------------------------------------------------------------------------

/** A group of content set apart: a tool's call, a plan. With `tone`, its edge says why it matters. */
export const Card = (props: StackProps): UIElement => (<VStack {...props} part="card" />) as UIElement;
/** Sunken content: output, code. */
export const Well = (props: StackProps): UIElement => (<VStack {...props} part="well" />) as UIElement;
/** What someone said. `side` "self" is the reader's own. */
export function Bubble(props: StackProps & { side?: "self" | "other" }): UIElement {
  const [own, box] = splitProps(props, ["side"]);
  return (<VStack {...box} part="bubble" variant={own.side ?? "other"} />) as UIElement;
}
/** A remark set beside the content: what happened, with the colour of how it went. */
export function Callout(props: { tone?: Tone; children: JSX.Element; onPress?: () => void; trailing?: UINode }): UIElement {
  return (
    <HStack part="callout" tone={props.tone ?? "muted"} spacing={6} align="start" onPress={props.onPress}>
      <VStack width={2} alignSelf="stretch" radius={1} background={toneColor(useUI(), props.tone ?? "muted")} />
      <VStack grow={1}>{props.children}</VStack>
      {props.trailing}
    </HStack>
  ) as UIElement;
}

/** A short message over the application: something was done, or was not. */
export function Toast(props: { text: string; tone?: Tone }): UIElement {
  const ui = useUI();
  return (
    <HStack anchor="top" padding={[8, 0, 0, 0]}>
      <HStack part="tooltip" tone={props.tone} maxWidth={Math.round(ui.size().width * 0.8)}>
        <Text>{props.text}</Text>
      </HStack>
    </HStack>
  ) as UIElement;
}

/** A name and its value on one line: a fact about the thing shown. */
export function Fact(props: { label: string; value: string | undefined; labelWidth?: number }): UIElement {
  const ui = useUI();
  return (
    <HStack hidden={!props.value} padding={[4, ui.metric().gutter]} spacing={8} align="start">
      <Text role="caption" tone="muted" width={props.labelWidth ?? 62} lines={1}>{props.label}</Text>
      <Text grow={1}>{props.value ?? ""}</Text>
    </HStack>
  ) as UIElement;
}

// ---------------------------------------------------------------------------
// Controls with a state
// ---------------------------------------------------------------------------

export interface PickerProps {
  /** what is being chosen: "Machine" */
  label: string;
  /** the present choice's name */
  value?: string;
  /** shown when there is no choice */
  placeholder?: string;
  /** a word about the present choice: "offline" */
  note?: string;
  /** the id of the present choice, marked in the list */
  selected?: string;
  options: () => readonly { id: string; title: string; detail?: string; trailing?: string; disabled?: boolean }[];
  onPick: (id: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  /** the width the label is set in where it sits beside the control (default 64) */
  labelWidth?: number;
  name?: string;
}

/** One choice of several. It is a row that opens the list in one tradition
 *  and, in another, the label beside a control that pops the list up under
 *  itself; the application says only what is chosen from what. */
export function Picker(props: PickerProps): UIElement {
  const ui = useUI();
  let control: Instance | undefined;
  const popup = () => ui.theme.traits.picker === "popup";
  const open = () =>
    presentMenu(ui, {
      title: props.label,
      anchor: popup() ? control : undefined,
      width: popup() && control ? Math.max(160, control.w) : undefined,
      items: () => props.options().map((option) => ({ ...option, checked: option.id === props.selected, run: () => props.onPick(option.id) })),
    });
  return (
    <VStack>
      <Show
        when={popup()}
        fallback={<Row title={props.value ?? props.placeholder ?? ""} eyebrow={props.label} trailing={props.note} disclosure disabled={props.disabled} autoFocus={props.autoFocus} onPress={open} name={props.name} />}
      >
        <HStack padding={[4, ui.metric().gutter + 4]} spacing={8}>
          <Text width={props.labelWidth ?? 64} align="right" tone="muted" lines={1}>{`${props.label}:`}</Text>
          <HStack part="picker" grow={1} minHeight={ui.metric().control} spacing={6} disabled={props.disabled} autoFocus={props.autoFocus} onPress={open} name={props.name} ref={(instance) => { control = instance; }}>
            <Text grow={1} lines={1} tone={props.value ? "plain" : "faint"}>{props.value ?? props.placeholder ?? ""}</Text>
            <Show when={props.note}>
              <Text role="caption" tone="faint" lines={1}>{props.note}</Text>
            </Show>
            <ZStack part="picker.button" width={ui.metric().control - 2} height={ui.metric().control - 2} disabled={props.disabled}>
              <Glyph glyph="updown" size={10} anchor="center" />
            </ZStack>
          </HStack>
        </HStack>
      </Show>
    </VStack>
  ) as UIElement;
}

/** A setting that is on or off: a check box in one tradition, a switch in another. */
export function Toggle(props: { label: string; on: boolean; onChange: (on: boolean) => void; disabled?: boolean; name?: string }): UIElement {
  const ui = useUI();
  return (
    <HStack spacing={8} padding={[5, ui.metric().gutter]} onPress={() => props.onChange(!props.on)} disabled={props.disabled} name={props.name} part="row">
      <Text grow={1} lines={1}>{props.label}</Text>
      <ZStack part="toggle" selected={props.on} disabled={props.disabled} width={ui.metric().toggle[0]} height={ui.metric().toggle[1]}>
        <ZStack part="toggle.knob" selected={props.on} anchor={props.on ? "trailing" : "leading"} width={ui.metric().knob[0]} height={ui.metric().knob[1]}>
          <Show when={props.on}>
            <Glyph glyph="check" size={Math.min(ui.metric().knob[0], ui.metric().knob[1]) - 4} anchor="center" state={{ variant: "toggle" }} />
          </Show>
        </ZStack>
      </ZStack>
    </HStack>
  ) as UIElement;
}

/** One of a few choices, all in view. */
export function Segmented<T extends string>(props: { options: readonly { id: T; label: string }[]; value: T; onChange: (id: T) => void; name?: string }): UIElement {
  return (
    <HStack part="segments" alignSelf="start">
      <For each={props.options}>
        {(option) => (
          <HStack part="segment" selected={props.value === option.id} onPress={() => props.onChange(option.id)} justify="center" name={props.name ? `${props.name}.${option.id}` : undefined}>
            <Text lines={1}>{option.label}</Text>
          </HStack>
        )}
      </For>
    </HStack>
  ) as UIElement;
}

/** How far along: `value` from 0 to 1. */
export function Progress(props: { value: number } & BoxProps): UIElement {
  const [own, box] = splitProps(props, ["value"]);
  let track: Instance | undefined;
  const [width, setWidth] = createSignal(0);
  const ui = useUI();
  const measure = () => {
    if (track?.placed && track.w !== width()) setWidth(track.w);
  };
  ui.root.afterLayout.add(measure);
  onCleanup(() => ui.root.afterLayout.delete(measure));
  return (
    <ZStack {...mergeProps({ height: 12 }, box)} part="progress" ref={(instance) => { track = instance; }}>
      <VStack part="progress.fill" anchor="leading" height="fill" width={Math.round(Math.max(0, Math.min(1, own.value)) * Math.max(0, width() - 2))} />
    </ZStack>
  ) as UIElement;
}

// ---------------------------------------------------------------------------
// A pane's bar, rows and sections
// ---------------------------------------------------------------------------

/** What a pane's content can know about the pane it is in. */
interface PaneInfo {
  /** it is a panel over another pane, under the bars: its own bar is a heading with a way to close it */
  panel: () => boolean;
  close: () => void;
}
const PaneContext = createContext<PaneInfo>();

export interface BarProps {
  title: string;
  /** a second line under the title */
  subtitle?: string;
  /** what leads the title: a status dot */
  leading?: UINode;
  /** the pane's commands: those marked `bar` show as controls where the surface has a bar */
  commands?: readonly Command[];
  /** show a Back control where the surface has a bar and there is something to go back to (default true) */
  back?: boolean;
  trailing?: UINode;
}

function BarControl(props: { label?: string; glyph?: GlyphName; tone?: Tone; disabled?: boolean; selected?: boolean; onPress: () => void; name: string }): UIElement {
  const ui = useUI();
  return (
    <HStack
      part="bar.button"
      tone={props.tone}
      disabled={props.disabled}
      selected={props.selected}
      onPress={props.onPress}
      name={props.name}
      spacing={4}
      justify="center"
      // every control of a bar is one height, a mark alone as tall as a word
      minHeight={ui.metric().control}
      minWidth={props.label ? undefined : ui.metric().control + 8}
    >
      <Show when={props.glyph}>
        <Glyph glyph={props.glyph!} size={9} tone={props.tone} />
      </Show>
      <Show when={props.label}>
        <Text lines={1} tone={props.tone}>{props.label}</Text>
      </Show>
    </HStack>
  ) as UIElement;
}

export function Bar(props: BarProps): UIElement {
  const ui = useUI();
  const center = useCommandCenter();
  const controls = createMemo(() => (ui.idioms().commands.bar ? (props.commands ?? []).filter((command) => command.bar) : []));
  // where commands sit in a menu bar, every one of them is there: the bar needs no "more"
  const overflow = createMemo(() => ui.idioms().commands.bar && ui.theme.traits.commands === "bar" && (props.commands ?? []).some((command) => !command.bar));
  const backShown = () => props.back !== false && ui.idioms().commands.bar && ui.idioms().panes === "stack" && center.canBack();
  const centred = () => ui.theme.traits.titleAlign === "center";
  // Where the frame's bars are one surface, every pane has a bar and all are
  // one height, with a second line or without, with a title or without: a
  // pane with nothing open still carries its stretch of the surface.
  const unified = () => ui.theme.traits.unifiedBars;
  const empty = () => !props.title && !props.leading && !props.trailing && controls().length === 0 && !backShown();
  // In a panel that lies over another pane, the bar is the panel's heading: its
  // title, and the control that closes it. The frame's bars are above it.
  const pane = useContext(PaneContext);
  const panel = () => pane?.panel() === true;
  return (
    <VStack hidden={empty() && !unified() && !panel()}>
      <HStack part="section" variant="panel" hidden={!panel()} spacing={6}>
        <Text lines={1} grow={1}>{ui.theme.traits.sectionCaps ? props.title.toUpperCase() : props.title}</Text>
        <ZStack part="caption.button" variant="close" width={ui.metric().captionButton[0]} height={ui.metric().captionButton[1]} focusable={false} onPress={() => pane?.close()} name="panel.close">
          <Glyph glyph="close" size={Math.min(ui.metric().captionButton[0], ui.metric().captionButton[1]) - 6} anchor="center" state={{ variant: "caption" }} />
        </ZStack>
      </HStack>
      <VStack hidden={panel()}>
      <HStack part="bar" height={unified() ? ui.metric().bar + 10 : undefined} minHeight={ui.metric().bar + (props.subtitle ? 10 : 0)} spacing={6}>
        <Show when={backShown()}>
          <BarControl label={ui.theme.traits.back === "label" ? "Back" : undefined} glyph="back" tone="accent" onPress={() => center.back()} name="bar.back" />
        </Show>
        {props.leading}
        <VStack grow={1} spacing={0} justify="center" align={centred() ? "center" : "stretch"}>
          <Text role="title" lines={1} align={centred() ? "center" : "left"}>{props.title}</Text>
          <Show when={props.subtitle}>
            <Text role="caption" tone="muted" lines={1} align={centred() ? "center" : "left"}>{props.subtitle}</Text>
          </Show>
        </VStack>
        {props.trailing}
        <For each={controls()}>
          {(command) => (
            <BarControl label={command.short ?? command.title} tone={command.destructive ? "bad" : "accent"} disabled={command.disabled} selected={command.checked} onPress={() => command.run()} name={`bar.${command.id}`} />
          )}
        </For>
        <Show when={overflow()}>
          <BarControl glyph="more" tone="accent" onPress={() => center.openMenu?.()} name="bar.more" />
        </Show>
      </HStack>
      <VStack height={1} part="divider" hidden={unified()} />
      </VStack>
    </VStack>
  ) as UIElement;
}

export interface RowProps extends BoxProps {
  title: string;
  /** one or two facts under the title */
  detail?: string;
  /** where it belongs, above the title */
  eyebrow?: string;
  leading?: UINode;
  /** a short value at the trailing edge */
  trailing?: string;
  trailingNode?: UINode;
  titleLines?: number;
  detailLines?: number;
  /** drawn quieter: read, done, archived */
  dim?: boolean;
  strong?: boolean;
  /** it opens something: a mark at the trailing edge says so */
  disclosure?: boolean;
}

export function Row(props: RowProps): UIElement {
  const ui = useUI();
  const [own, box] = splitProps(props, ["title", "detail", "eyebrow", "leading", "trailing", "trailingNode", "titleLines", "detailLines", "dim", "strong", "disclosure"]);
  return (
    <VStack>
      <HStack {...mergeProps({ align: "start" as const }, box)} spacing={8} part="row">
        <Show when={own.leading}>
          <VStack padding={[4, 0, 0, 0]}>{own.leading}</VStack>
        </Show>
        <VStack grow={1} spacing={1}>
          <Show when={own.eyebrow}>
            <Text role="caption" tone="faint" lines={1}>{own.eyebrow}</Text>
          </Show>
          <Text role={own.strong === false ? "body" : "strong"} tone={own.dim ? "muted" : "plain"} lines={own.titleLines ?? 1}>{own.title}</Text>
          <Show when={own.detail}>
            <Text role="caption" tone="muted" lines={own.detailLines ?? 1}>{own.detail}</Text>
          </Show>
        </VStack>
        <Show when={own.trailing}>
          <Text role="caption" tone="faint" lines={1} padding={[2, 0, 0, 0]}>{own.trailing}</Text>
        </Show>
        {own.trailingNode}
        <Show when={own.disclosure}>
          <Glyph glyph="disclosure" size={8} tone="faint" padding={[4, 0, 0, 0]} />
        </Show>
      </HStack>
      <VStack height={1} part="divider" hidden={!ui.theme.traits.rowRules} />
    </VStack>
  ) as UIElement;
}

/** A heading between groups of rows. */
export function Section(props: { title: string; trailing?: string }): UIElement {
  const ui = useUI();
  return (
    <HStack part="section">
      <Text lines={1} grow={1}>{ui.theme.traits.sectionCaps ? props.title.toUpperCase() : props.title}</Text>
      <Show when={props.trailing}>
        <Text role="caption" tone="faint" lines={1}>{props.trailing}</Text>
      </Show>
    </HStack>
  ) as UIElement;
}

/** What a pane shows when it has nothing: what is so, and what to do next. */
export function Placeholder(props: { title: string; detail?: string; action?: { label: string; run: () => void } }): UIElement {
  return (
    <VStack grow={1} justify="center" align="center" padding={20} spacing={6}>
      <Text role="title" align="center" maxWidth={280}>{props.title}</Text>
      <Show when={props.detail}>
        <Text tone="muted" align="center" maxWidth={300}>{props.detail}</Text>
      </Show>
      {/* read through `?.`: a prop's getter can run once more after the action is gone and before Show drops the button */}
      <Show when={props.action}>
        <VStack height={4} />
        <Button label={props.action?.label ?? ""} kind="filled" onPress={() => props.action?.run()} alignSelf="center" />
      </Show>
    </VStack>
  ) as UIElement;
}

// ---------------------------------------------------------------------------
// Menus and dialogs
// ---------------------------------------------------------------------------

export interface MenuItem {
  id: string;
  title: string;
  detail?: string;
  trailing?: string;
  tone?: Tone;
  disabled?: boolean;
  checked?: boolean;
  run(): void;
}

function MenuRows(props: { items: readonly MenuItem[]; close: () => void; maxHeight: number }): UIElement {
  return (
    <Scroll maxHeight={props.maxHeight} bar="never">
      <For each={props.items}>
        {(item) => (
          <HStack
            part="menu.item"
            tone={item.tone}
            spacing={8}
            disabled={item.disabled}
            name={`menu.${item.id}`}
            onPress={() => {
              props.close();
              item.run();
            }}
          >
            <ZStack width={10} height={10}>
              <Show when={item.checked}>
                <Glyph glyph="check" size={9} anchor="center" />
              </Show>
            </ZStack>
            <VStack grow={1} spacing={1}>
              <Text lines={1} tone={item.tone}>{item.title}</Text>
              <Show when={item.detail}>
                <Text role="caption" tone="muted" lines={2}>{item.detail}</Text>
              </Show>
            </VStack>
            <Show when={item.trailing}>
              <Text role="caption" tone="faint" lines={1}>{item.trailing}</Text>
            </Show>
          </HStack>
        )}
      </For>
    </Scroll>
  ) as UIElement;
}

/** A list of things to pick one of, presented over the application the way the theme presents a menu, or beside `anchor`. */
export function presentMenu(ui: UI, options: { title?: string; items: () => readonly MenuItem[]; anchor?: Instance; width?: number; onDismiss?: () => void }): Presentation {
  // what a menu lists is fixed when it opens: rows do not change under the reader, or under the focus
  const items = untrack(options.items);
  const sheet: Presentation = present(ui, () => <MenuRows items={items} close={() => sheet.dismiss()} maxHeight={Math.round(ui.size().height * 0.7)} />, {
    style: options.anchor ? "popover" : "menu",
    anchor: options.anchor?.frame(),
    width: options.width,
    title: options.anchor ? undefined : options.title,
    onDismiss: options.onDismiss,
  });
  return sheet;
}

/** Ask before something that is undone only by doing the opposite. The button names what it does. */
export function confirm(ui: UI, options: { title: string; message?: string; action: string; destructive?: boolean; run: () => void }): Presentation {
  // The title and the two buttons are the panel's (ui/present.ts): a title bar
  // or a heading, and the buttons in the order and at the end the theme has them.
  const sheet: Presentation = present(
    ui,
    () => (
      <VStack padding={[8, 14, 4, 14]}>
        <Show when={options.message}>
          <Text tone="muted">{options.message}</Text>
        </Show>
      </VStack>
    ),
    {
      style: "dialog",
      title: options.title,
      actions: () => [
        { label: "Cancel", role: "cancel" },
        { label: options.action, role: options.destructive ? "destructive" : "primary", run: () => { sheet.dismiss(); options.run(); } },
      ],
    },
  );
  return sheet;
}

// ---------------------------------------------------------------------------
// The application's frame
// ---------------------------------------------------------------------------

/** The strip at the bottom of the frame: a line of status, and what each button does now. */
export function Legend(props: { status?: string }): UIElement {
  const ui = useUI();
  const center = useCommandCenter();
  const shown = () => ui.idioms().commands.legend || (props.status !== undefined && ui.theme.traits.caption);
  return (
    <HStack part="status" hidden={!shown()} minHeight={ui.metric().status} spacing={8}>
      <HStack part="status.cell" grow={1} alignSelf="stretch">
        <Text role="caption" lines={1} grow={1}>{props.status ?? ""}</Text>
      </HStack>
      <Show when={ui.idioms().commands.legend}>
        <HStack part="status.cell" spacing={12} alignSelf="stretch">
          <For each={center.legend()}>
            {(entry) => (
              <HStack spacing={4}>
                <Text role="caption" tone="accent" lines={1}>{entry.glyph}</Text>
                <Text role="caption" lines={1}>{entry.label}</Text>
              </HStack>
            )}
          </For>
        </HStack>
      </Show>
    </HStack>
  ) as UIElement;
}

/** The menus across the frame: every command that applies now, under the menu it names. */
function MenuBar(props: { appMenu: string }): UIElement {
  const ui = useUI();
  const center = useCommandCenter();
  const [open, setOpen] = createSignal<string | null>(null);
  const menus = createMemo(() => {
    const groups = new Map<string, Command[]>();
    for (const command of center.bound().all) {
      if (command.id === "commands.menu") continue;
      const name = command.menu ?? props.appMenu;
      const list = groups.get(name);
      if (list) list.push(command);
      else groups.set(name, [command]);
    }
    // the application's own menu first, as its tradition has it
    return [...groups.keys()].sort((a, b) => (a === props.appMenu ? -1 : b === props.appMenu ? 1 : 0));
  });
  const show = (name: string, anchor: Instance) => {
    setOpen(name);
    presentMenu(ui, {
      anchor,
      width: 210,
      onDismiss: () => setOpen(null),
      items: () =>
        center
          .bound()
          .all.filter((command) => command.id !== "commands.menu" && (command.menu ?? props.appMenu) === name)
          .map((command) => ({ id: command.id, title: command.title, trailing: ui.idioms().commands.shortcuts ? command.key : undefined, tone: command.destructive ? ("bad" as const) : undefined, disabled: command.disabled, checked: command.checked, run: command.run })),
    });
  };
  return (
    <HStack part="menubar" minHeight={ui.metric().menubar}>
      <For each={menus()}>
        {(name) => {
          let item: Instance | undefined;
          // the menu bar is the pointer's; the pad opens the whole list with its menu button
          return (
            <HStack part="menubar.item" selected={open() === name} focusable={false} onPress={() => item && show(name, item)} ref={(instance) => { item = instance; }} name={`menubar.${name}`}>
              <Text lines={1}>{name}</Text>
            </HStack>
          );
        }}
      </For>
    </HStack>
  ) as UIElement;
}

export interface ScaffoldProps {
  children: JSX.Element;
  /** the application's name: its title bar's, where the theme gives the frame one, and its own menu's */
  title?: string;
  /** what is open in it now: named before the application in its title bar ("Report - Notes") */
  document?: string;
  /** one line about the whole application now, for the strip at the bottom where the theme has one */
  status?: string;
  menuTitle?: string;
  /** what the title bar's close control does now: close what is open. Undefined while nothing is open: the control shows disabled. Never given: the frame has no close control */
  onClose?: () => void;
  /** the frame's title bar has a close control (default: whether `onClose` was ever given) */
  closable?: boolean;
}

/** The application's frame: a title bar and a menu bar where the theme's tradition has them, the content, and the strip of status and legend; and the command menu behind the pad's menu button and the bars' "more". */
export function Scaffold(props: ScaffoldProps): UIElement {
  const ui = useUI();
  const center = useCommandCenter();
  let menu: Presentation | null = null;
  center.openMenu = () => {
    if (menu?.open) return;
    menu = presentMenu(ui, {
      title: props.menuTitle ?? "Commands",
      items: () => center.bound().all.filter((command) => command.id !== "commands.menu").map((command) => ({ id: command.id, title: command.title, trailing: ui.idioms().commands.shortcuts ? command.key : undefined, tone: command.destructive ? "bad" : undefined, disabled: command.disabled, checked: command.checked, run: command.run })),
    });
  };
  const title = () => props.title ?? "";
  return (
    <VStack part="canvas">
      <Show when={ui.theme.traits.caption && title() !== ""}>{caption(ui, { part: "caption", title: () => (props.document ? `${props.document} - ${title()}` : title()), close: props.closable || "onClose" in props ? () => props.onClose : undefined })}</Show>
      <Show when={ui.theme.traits.commands === "menubar" && ui.idioms().commands.bar}>
        <MenuBar appMenu={title() || "Menu"} />
      </Show>
      <VStack grow={1}>{props.children}</VStack>
      <Legend status={props.status} />
    </VStack>
  ) as UIElement;
}

// ---------------------------------------------------------------------------
// Panes
// ---------------------------------------------------------------------------

export interface PanesViewProps {
  /** 0 the list alone, 1 a detail is open, 2 its inspector too */
  depth: number;
  /** Back closed the deepest pane: make `depth` one less */
  onClose: (pane: "detail" | "inspector") => void;
  list: JSX.Element;
  detail: JSX.Element;
  inspector?: JSX.Element;
  listWidth?: number;
  inspectorWidth?: number;
  /** takes no room and paints nothing; the panes keep their state */
  hidden?: boolean;
}

/** List, detail and inspector as the surface has room for them (ui/panes.ts). */
export function Panes(props: PanesViewProps): UIElement {
  const ui = useUI();
  const close = () => {
    if (props.depth >= 2) props.onClose("inspector");
    else if (props.depth === 1) props.onClose("detail");
  };
  // Back closes a pane where panes cover one another; in columns only the inspector covers anything
  useBack(
    () => {
      if (props.depth >= 2 || (props.depth === 1 && ui.idioms().panes === "stack")) {
        close();
        return true;
      }
      return false;
    },
    () => props.depth >= 2 || (props.depth === 1 && ui.idioms().panes === "stack"),
  );
  // made once: the panes hold the application's state
  // the inspector lies over the detail where the panes are two columns: a panel under the bars
  const panel = () => ui.idioms().panes === "split";
  const info: PaneInfo = { panel, close: () => props.onClose("inspector") };
  const inspector = PaneContext.Provider({
    value: info,
    get children() {
      return props.inspector;
    },
  });
  const panes = [<ZStack part="pane">{props.list}</ZStack>, <ZStack part="pane.detail">{props.detail}</ZStack>, <ZStack part="sidebar" variant={panel() ? "panel" : undefined}>{inspector}</ZStack>];
  return element(PANES, {
    grow: 1,
    get hidden() {
      return props.hidden;
    },
    get index() {
      return props.depth;
    },
    get idiom() {
      return ui.idioms().panes;
    },
    get transition() {
      return ui.theme.traits.motion === "cut" ? ("cut" as const) : ui.idioms().transition;
    },
    get listWidth() {
      return props.listWidth;
    },
    get inspectorWidth() {
      return props.inspectorWidth;
    },
    get inspectorTop() {
      // the height of a pane's bar with its second line, and the rule under it where the theme draws one
      return ui.metric().bar + 10 + (ui.theme.traits.unifiedBars ? 0 : 1);
    },
    onBack: close,
    children: panes as unknown as UINode,
  });
}

// PocketUI ui/primitives.ts — the elements everything else is composed of,
// as components.
import { mergeProps, splitProps } from "solid-js";
import { DECK, type DeckProps } from "./deck.ts";
import { TEXT_EDITOR, type TextEditorProps } from "./editor.ts";
import { element, HSTACK, VSTACK, ZSTACK, type BoxProps, type Instance, type Kind, type ScrollTarget, type StackProps, type UIElement, type UINode } from "./engine.ts";
import { GLYPH, type GlyphProps } from "./glyph.ts";
import { MATRIX, type MatrixProps } from "./matrix.ts";
import { SCROLLBAR } from "./scrollbar.ts";
import { FEED, type FeedProps } from "./feed.ts";
import { RICH_TEXT, type RichTextProps } from "./richview.ts";
import { SCROLL, type ScrollProps } from "./scroll.ts";
import { TEXT, type TextProps } from "./textview.ts";

/** Children top to bottom. They take the stack's width unless `align` says otherwise. */
export const VStack = (props: StackProps): UIElement => element(VSTACK, props);
/** Children left to right, centred across. */
export const HStack = (props: StackProps): UIElement => element(HSTACK, props);
/** Children over one another, each filling the stack unless it has an `anchor`. */
export const ZStack = (props: StackProps): UIElement => element(ZSTACK, props);
/** Takes the leftover room of the stack it is in. */
export const Spacer = (props: BoxProps): UIElement => element(VSTACK, mergeProps({ grow: 1 }, props));
/** A paragraph in one style: wraps to its width. */
export const Text = (props: TextProps): UIElement => element(TEXT, props);
/** A paragraph in several styles. */
export const RichText = (props: RichTextProps): UIElement => element(RICH_TEXT, props);
/** A matrix code from its modules: dark on light in every theme, for a camera to read. */
export const MatrixCode = (props: MatrixProps): UIElement => element(MATRIX, props);
/** A mark the theme draws: a cross, a check, a chevron. */
export const Glyph = (props: GlyphProps): UIElement => element(GLYPH, props);

/** The props that say where a scroll view sits and what it is set on: they
 *  go to the row that holds it and its scroll bar; the rest are the view's. */
const FRAME = ["width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight", "grow", "alignSelf", "anchor", "hidden", "part", "variant", "tone", "selected", "active", "background", "radius", "borderColor", "borderWidth", "shadow", "opacity", "offset"] as const;

/** A scroll view and the strip a theme may put beside it (ui/scrollbar.ts).
 *  The row is there under every theme, so changing theme moves nothing in
 *  the tree: the strip takes no room where the theme's scroll bar is a thumb
 *  over the content. */
function withBar<P extends BoxProps & { bar?: "auto" | "never" }>(kind: Kind<P>, props: P): UIElement {
  const [frame, inner] = splitProps(props as BoxProps & { bar?: "auto" | "never" }, FRAME);
  let view: Instance | undefined;
  const target = (): ScrollTarget | null => view?.scrollTarget() ?? null;
  const children = [
    element(kind, mergeProps(inner, { grow: 1, ref: (instance: Instance) => { view = instance; inner.ref?.(instance); } }) as unknown as P),
    element(SCROLLBAR, { target, get never() { return props.bar === "never"; } }),
  ];
  return element(HSTACK, mergeProps(frame, { align: "stretch" as const, children: children as UINode }));
}

/** Content taller than its box, moved by a pan, a fling, the d-pad or the focus. */
export const Scroll = (props: ScrollProps): UIElement => withBar(SCROLL, props);
/** Rows of any height and number, mounted near the window only, anchored where the reader is. */
export const Feed = <T,>(props: FeedProps<T>): UIElement => withBar(FEED as Kind<FeedProps<T>>, props);
/** Panes one at a time; the change between two can be followed and reversed. */
export const Deck = (props: DeckProps): UIElement => element(DECK, props);
/** A multi-line field with mention tokens, a caret, a selection and an IME's preedit. */
export const TextEditor = (props: TextEditorProps): UIElement => element(TEXT_EDITOR, props);

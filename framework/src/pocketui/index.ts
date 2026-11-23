// @pocketjs/framework/ui — PocketUI, the semantic UI layer for PocketJS
// applications (docs/POCKETUI.md). An application names parts and what they
// mean; a theme paints and arranges them. This file is the public surface.

export type { Align, Anchor, BoxProps, Edges, Instance, Rect, Size, StackProps, UIElement, UINode } from "./ui/engine.ts";
export type { FeedAnchor } from "./core/feed.ts";
export type { FeedHandle, FeedProps } from "./ui/feed.ts";
export type { ScrollHandle, ScrollProps } from "./ui/scroll.ts";
export type { TextProps } from "./ui/textview.ts";
export type { Environment, Idioms } from "./core/env.ts";
export { deriveEnvironment, resolveIdioms } from "./core/env.ts";
export { mountPocketUI, PocketUI, useUI, type PocketUIProps, type UI } from "./ui/mount.ts";
export { defineTheme, FACES, PIXEL_FACES, REST, withFaces, type Bevel, type Face, type Fill, type GlyphArt, type GlyphName, type GlyphShape, type Ink, type Layer, type Paint, type Palette, type Part, type PartState, type TextRole, type Theme, type Traits } from "./core/theme.ts";
export { AQUA_THEME, CLASSIC_THEME, DARK, DEFAULT_THEME, LUNA_THEME, POCKET_THEME, themeById, THEMES } from "./themes/index.ts";
export { bitmap, NO_GLYPH, stockGlyph, stroke } from "./core/glyphs.ts";
export type { GlyphProps } from "./ui/glyph.ts";

export type { ScrollTarget } from "./ui/engine.ts";
export { element } from "./ui/engine.ts";
export type { DeckProps } from "./ui/deck.ts";
export type { RichSpan, RichTextProps } from "./ui/richview.ts";
export type { Command, ButtonIntent } from "./core/commands.ts";
export { searchCommands } from "./core/commands.ts";
export { useBack, useCommandCenter, useCommands, type CommandCenter } from "./ui/commands.ts";
export type { MatrixProps } from "./ui/matrix.ts";
export { Deck, Feed, Glyph, HStack, MatrixCode, RichText, Scroll, Spacer, Text, TextEditor, VStack, ZStack } from "./ui/primitives.ts";
export type { EditorHandle, TextEditorProps } from "./ui/editor.ts";
export type { Editor, EditorSnapshot, Token } from "./core/editor.ts";
export { Badge, Bar, Bubble, Button, Callout, Card, confirm, Divider, Fact, Label, Legend, Panes, Picker, Placeholder, presentMenu, Progress, Row, Scaffold, Section, Segmented, StatusDot, Toast, Toggle, toneColor, Well, type BarProps, type ButtonProps, type MenuItem, type PanesViewProps, type PickerProps, type RowProps, type ScaffoldProps, type Tone } from "./ui/kit.tsx";
export { Markdown, type MarkdownProps } from "./ui/markdown.ts";
export { present, type Presentation, type PresentOptions } from "./ui/present.ts";
export { forgetMeasures, measureIn, resolveFace, resolveRuns, setFaceResolver, setTextSource, type FaceResolver, type ResolvedText, type TextRun, type TextSource } from "./ui/textview.ts";
export { installRuntimeText, type FaceStats, type GlyphRequest, type GlyphTransport, type RuntimeText, type RuntimeTextOptions, type RuntimeTextStats } from "./ui/runtimetext.ts";
export { createRuntimeFaces, type RuntimeFaces, type RuntimeFacesOptions } from "./core/runtimefaces.ts";
export { encodeAtlas, GlyphTable, needsRuntime, parseAtlas, planParts, splitRuns, type AtlasGlyph, type ParsedAtlas, type ScriptRun } from "./core/glyphfont.ts";
export { RICH_BOLD_FACE, RICH_FACE, type Metrics } from "./core/theme.ts";
export { COMPACT_METRICS, REGULAR_METRICS } from "./themes/index.ts";
export type { DropTarget, TransferCenter, TransferItem } from "./ui/transfer.ts";

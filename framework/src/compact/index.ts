// Pocket Compact UI: the kit for a small panel driven by keys. Glance first:
// the status bar and the hint bar frame every scene; action oriented: one
// scene does one task, with the controls and instruments it needs and no
// more; keyboard driven: one vocabulary of keys (input.ts) on every screen,
// and the same vocabulary from a d-pad where there is no keyboard.
//
// docs/COMPACT-UI.md states the rules; apps/zero-tools is the reference
// application.

export * from "./tokens.ts";
export * from "./text.ts";
export { MOTION, FADES, SECTION_SHIFT, glide, place, createFollower, slideIn, slideOut, slideFrom, arrive, flip, pop, bump, type Rect } from "./motion.ts";
export { navKeyOf, onNavIn, onKeyIn, setActiveScope, activeInputScope, installCompactInput, GLOBAL_SCOPE, KEY_LABEL, type NavKey, type NavEvent, type NavHandler, type KeyHandler, type Scope } from "./input.ts";
export { CompactApp, useScenes, useSceneActive, useNav, useKey, useHints, useTitle, toast, confirm, type SceneDef, type Scenes, type CompactAppProps, type ConfirmOptions } from "./app.tsx";
export {
  createSelection,
  useListNav,
  List,
  ValueRows,
  useValueRows,
  stepValue,
  cycle,
  TextField,
  Progress,
  Panel,
  Chip,
  KeyValue,
  ActionPad,
  useActionPad,
  Detail,
  SectionTabs,
  AppGrid,
  useAppGrid,
  layoutTiles,
  gridMetrics,
  GRID,
  GRID_SIZES,
  SectionBody,
  display,
  type SectionTabsProps,
  type GridTile,
  type GridLayout,
  type GridMetrics,
  type GridSize,
  type SectionBodyProps,
  type PlacedTile,
  type AppGridProps,
  type AppGridNavOptions,
  type Selection,
  type ListNavOptions,
  type ListProps,
  type ValueRow,
  type ValueRowsProps,
  type TextFieldProps,
  type ProgressProps,
  type PanelProps,
  type PadAction,
  type ActionPadProps,
  type DetailProps,
} from "./controls.tsx";
export {
  Digits,
  digitsWidth,
  Gauge,
  Tuner,
  BubbleLevel,
  TapeCompass,
  SignalMeter,
  Bars,
  RecorderStrip,
  StatusMatrix,
  type DigitSize,
  type DigitsProps,
  type GaugeProps,
  type TunerProps,
  type BubbleLevelProps,
  type TapeCompassProps,
  type SignalMeterProps,
  type BarsProps,
  type RecorderStripProps,
  type MatrixCell,
  type StatusMatrixProps,
} from "./instruments.tsx";

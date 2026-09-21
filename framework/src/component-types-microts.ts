// GENERATED — do not edit; run `bun contracts/spec/gen-rust.ts`.
import type { i8, i16, i32, i64, u8, u16, u32, u64, usize, f32, Px, Ms, Deg, Color } from "./numeric-microts.ts";
export type MicroTsFloatInput = i8 | i16 | i32 | i64 | u8 | u16 | u32 | u64 | usize | f32;
export type MicroTsIntegerInput = i8 | i16 | i32 | i64 | u8 | u16 | u32 | u64 | usize;
export type MicroTsValue<T> = T | (() => T);
export interface MicroTsStyleProps {
  width?: Px | MicroTsIntegerInput;
  height?: Px | MicroTsIntegerInput;
  minW?: Px | MicroTsIntegerInput;
  minH?: Px | MicroTsIntegerInput;
  maxW?: Px | MicroTsIntegerInput;
  maxH?: Px | MicroTsIntegerInput;
  paddingT?: Px | MicroTsIntegerInput;
  paddingR?: Px | MicroTsIntegerInput;
  paddingB?: Px | MicroTsIntegerInput;
  paddingL?: Px | MicroTsIntegerInput;
  marginT?: Px | MicroTsIntegerInput;
  marginR?: Px | MicroTsIntegerInput;
  marginB?: Px | MicroTsIntegerInput;
  marginL?: Px | MicroTsIntegerInput;
  gap?: Px | MicroTsIntegerInput;
  flexDir?: i32;
  justify?: i32;
  align?: i32;
  grow?: MicroTsFloatInput;
  shrink?: MicroTsFloatInput;
  basis?: Px | MicroTsIntegerInput;
  flexWrap?: i32;
  posType?: i32;
  insetT?: Px | MicroTsIntegerInput;
  insetR?: Px | MicroTsIntegerInput;
  insetB?: Px | MicroTsIntegerInput;
  insetL?: Px | MicroTsIntegerInput;
  display?: i32;
  overflow?: i32;
  zIndex?: i32;
  hitPass?: i32;
  bgColor?: Color;
  gradFrom?: Color;
  gradTo?: Color;
  gradDir?: i32;
  radius?: Px | MicroTsIntegerInput;
  opacity?: MicroTsFloatInput;
  borderColor?: Color;
  borderWidth?: Px | MicroTsIntegerInput;
  shadow?: i32;
  bevelOuterLight?: Color;
  bevelOuterDark?: Color;
  bevelInnerLight?: Color;
  bevelInnerDark?: Color;
  bevelWidth?: Px | MicroTsIntegerInput;
  gradVia?: Color;
  gradViaPos?: MicroTsFloatInput;
  textColor?: Color;
  fontSlot?: i32;
  textAlign?: i32;
  lineHeight?: Px | MicroTsIntegerInput;
  tracking?: Px | MicroTsIntegerInput;
  translateX?: Px | MicroTsIntegerInput;
  translateY?: Px | MicroTsIntegerInput;
  scale?: MicroTsFloatInput;
  rotate?: Deg | MicroTsIntegerInput;
  scaleX?: MicroTsFloatInput;
  scaleY?: MicroTsFloatInput;
  originX?: MicroTsFloatInput;
  originY?: MicroTsFloatInput;
  rotateX?: Deg | MicroTsIntegerInput;
  rotateY?: Deg | MicroTsIntegerInput;
  translateZ?: Px | MicroTsIntegerInput;
  perspective?: Px | MicroTsIntegerInput;
  arcStart?: Deg | MicroTsIntegerInput;
  arcSweep?: Deg | MicroTsIntegerInput;
  arcWidth?: Px | MicroTsIntegerInput;
}
export interface MicroTsViewBaseProps {
  "class"?: MicroTsValue<string>;
  "style"?: MicroTsValue<MicroTsStyleProps>;
  "debug-name"?: MicroTsValue<string>;
}
export type MicroTsViewProps = MicroTsViewBaseProps & ({ focusable: true; onPress?: () => void } | { focusable?: false; onPress?: never });
export interface MicroTsTextProps {
  "class"?: MicroTsValue<string>;
}
export interface MicroTsImageProps {
  "class"?: MicroTsValue<string>;
  "src"?: MicroTsValue<string>;
}
export interface MicroTsActionHandlerProps { button: number; active?: MicroTsValue<boolean>; latched?: boolean; onPress?: (pressed: number, buttons: number) => void }
export interface MicroTsAxisHandlerProps { axis: "primary" | "secondary"; active?: MicroTsValue<boolean>; onDelta?: (delta: i32) => void }

// GENERATED — do not edit; run `bun contracts/spec/gen-rust.ts`.
import type { i8, i16, i32, i64, u8, u16, u32, u64, usize, f32, Px, Ms, Deg, Color } from "./numeric-vue-vapor.ts";
export type VaporFloatInput = i8 | i16 | i32 | i64 | u8 | u16 | u32 | u64 | usize | f32;
export type VaporIntegerInput = i8 | i16 | i32 | i64 | u8 | u16 | u32 | u64 | usize;
export type VaporValue<T> = T | (() => T);
export interface VaporStyleProps {
  width?: Px | VaporIntegerInput;
  height?: Px | VaporIntegerInput;
  minW?: Px | VaporIntegerInput;
  minH?: Px | VaporIntegerInput;
  maxW?: Px | VaporIntegerInput;
  maxH?: Px | VaporIntegerInput;
  paddingT?: Px | VaporIntegerInput;
  paddingR?: Px | VaporIntegerInput;
  paddingB?: Px | VaporIntegerInput;
  paddingL?: Px | VaporIntegerInput;
  marginT?: Px | VaporIntegerInput;
  marginR?: Px | VaporIntegerInput;
  marginB?: Px | VaporIntegerInput;
  marginL?: Px | VaporIntegerInput;
  gap?: Px | VaporIntegerInput;
  flexDir?: i32;
  justify?: i32;
  align?: i32;
  grow?: VaporFloatInput;
  shrink?: VaporFloatInput;
  basis?: Px | VaporIntegerInput;
  flexWrap?: i32;
  posType?: i32;
  insetT?: Px | VaporIntegerInput;
  insetR?: Px | VaporIntegerInput;
  insetB?: Px | VaporIntegerInput;
  insetL?: Px | VaporIntegerInput;
  display?: i32;
  overflow?: i32;
  zIndex?: i32;
  hitPass?: i32;
  bgColor?: Color;
  gradFrom?: Color;
  gradTo?: Color;
  gradDir?: i32;
  radius?: Px | VaporIntegerInput;
  opacity?: VaporFloatInput;
  borderColor?: Color;
  borderWidth?: Px | VaporIntegerInput;
  shadow?: i32;
  bevelOuterLight?: Color;
  bevelOuterDark?: Color;
  bevelInnerLight?: Color;
  bevelInnerDark?: Color;
  bevelWidth?: Px | VaporIntegerInput;
  gradVia?: Color;
  gradViaPos?: VaporFloatInput;
  textColor?: Color;
  fontSlot?: i32;
  textAlign?: i32;
  lineHeight?: Px | VaporIntegerInput;
  tracking?: Px | VaporIntegerInput;
  translateX?: Px | VaporIntegerInput;
  translateY?: Px | VaporIntegerInput;
  scale?: VaporFloatInput;
  rotate?: Deg | VaporIntegerInput;
  scaleX?: VaporFloatInput;
  scaleY?: VaporFloatInput;
  originX?: VaporFloatInput;
  originY?: VaporFloatInput;
  rotateX?: Deg | VaporIntegerInput;
  rotateY?: Deg | VaporIntegerInput;
  translateZ?: Px | VaporIntegerInput;
  perspective?: Px | VaporIntegerInput;
  arcStart?: Deg | VaporIntegerInput;
  arcSweep?: Deg | VaporIntegerInput;
  arcWidth?: Px | VaporIntegerInput;
}
export interface VaporViewBaseProps {
  "class"?: VaporValue<string>;
  "style"?: VaporValue<VaporStyleProps>;
  "debug-name"?: VaporValue<string>;
}
export type VaporViewProps = VaporViewBaseProps & ({ focusable: true; onPress?: () => void } | { focusable?: false; onPress?: never });
export interface VaporTextProps {
  "class"?: VaporValue<string>;
}
export interface VaporImageProps {
  "class"?: VaporValue<string>;
  "src"?: VaporValue<string>;
}
export interface VaporActionHandlerProps { button: number; active?: VaporValue<boolean>; latched?: boolean; onPress?: (pressed: number, buttons: number) => void }
export interface VaporAxisHandlerProps { axis: "primary" | "secondary"; active?: VaporValue<boolean>; onDelta?: (delta: i32) => void }

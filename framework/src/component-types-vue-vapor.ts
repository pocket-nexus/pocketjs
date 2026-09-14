// GENERATED — do not edit; run `bun contracts/spec/gen-rust.ts`.
import type { i8, i16, i32, i64, u8, u16, u32, u64, usize, f32 } from "./numeric-vue-vapor.ts";
export type VaporFloatInput = i8 | i16 | i32 | i64 | u8 | u16 | u32 | u64 | usize | f32;
export interface VaporStyleProps {
  width?: VaporFloatInput;
  height?: VaporFloatInput;
  minW?: VaporFloatInput;
  minH?: VaporFloatInput;
  maxW?: VaporFloatInput;
  maxH?: VaporFloatInput;
  paddingT?: VaporFloatInput;
  paddingR?: VaporFloatInput;
  paddingB?: VaporFloatInput;
  paddingL?: VaporFloatInput;
  marginT?: VaporFloatInput;
  marginR?: VaporFloatInput;
  marginB?: VaporFloatInput;
  marginL?: VaporFloatInput;
  gap?: VaporFloatInput;
  flexDir?: i32;
  justify?: i32;
  align?: i32;
  grow?: VaporFloatInput;
  shrink?: VaporFloatInput;
  basis?: VaporFloatInput;
  flexWrap?: i32;
  posType?: i32;
  insetT?: VaporFloatInput;
  insetR?: VaporFloatInput;
  insetB?: VaporFloatInput;
  insetL?: VaporFloatInput;
  display?: i32;
  overflow?: i32;
  zIndex?: i32;
  hitPass?: i32;
  bgColor?: u32;
  gradFrom?: u32;
  gradTo?: u32;
  gradDir?: i32;
  radius?: VaporFloatInput;
  opacity?: VaporFloatInput;
  borderColor?: u32;
  borderWidth?: VaporFloatInput;
  shadow?: i32;
  bevelOuterLight?: u32;
  bevelOuterDark?: u32;
  bevelInnerLight?: u32;
  bevelInnerDark?: u32;
  bevelWidth?: VaporFloatInput;
  gradVia?: u32;
  gradViaPos?: VaporFloatInput;
  textColor?: u32;
  fontSlot?: i32;
  textAlign?: i32;
  lineHeight?: VaporFloatInput;
  tracking?: VaporFloatInput;
  translateX?: VaporFloatInput;
  translateY?: VaporFloatInput;
  scale?: VaporFloatInput;
  rotate?: VaporFloatInput;
  scaleX?: VaporFloatInput;
  scaleY?: VaporFloatInput;
  originX?: VaporFloatInput;
  originY?: VaporFloatInput;
  rotateX?: VaporFloatInput;
  rotateY?: VaporFloatInput;
  translateZ?: VaporFloatInput;
  perspective?: VaporFloatInput;
  arcStart?: VaporFloatInput;
  arcSweep?: VaporFloatInput;
  arcWidth?: VaporFloatInput;
}
export interface VaporViewProps {
  "class"?: string;
  "style"?: VaporStyleProps;
  "focusable"?: boolean;
  "debug-name"?: string;
  onPress?: () => void;
}
export interface VaporTextProps {
  "class"?: string;
}
export interface VaporImageProps {
  "class"?: string;
  "src"?: string;
}

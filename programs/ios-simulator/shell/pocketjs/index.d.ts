import { View } from '@nativescript/core';
export declare class PocketView extends View {
  src: string;
  viewportWidth: number;
  viewportHeight: number;
  density: number;
  tickRate: number;
  post(value: unknown): void;
}
export declare class PocketHostView extends PocketView {}

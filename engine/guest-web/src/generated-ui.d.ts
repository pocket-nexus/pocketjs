/** Synchronous native transport; records follow contracts/spec/ui-ops.ts. */
export const POCKET_BINDING_GENERATION: number;
export type UiArgument = { kind: "integer" | "real"; value: number } | { kind: "bytes"; value: Uint8Array };
export type UiResult = { kind: "none" } | { kind: "integer" | "real"; value: number } | { kind: "bytes"; value: Uint8Array };
export interface UiTransport {
  supportsOp(operation: number): boolean;
  dispatch(operation: number, arguments_: UiArgument[]): UiResult;
}
export interface GuestEnvironment {
  host: string;
  hostAbi: number;
  tickHz: number;
  viewport: { w: number; h: number };
  rasterDensity: number;
  auxiliary?: { root: number; w: number; h: number };
  pak?: ArrayBuffer | ArrayBufferView;
  textures?: { name: string; handle: number }[];
  sprites?: { name: string; handle: number; frames: number; columns: number; step: number }[];
}
/** Mount rejects unsupported hostAbi before querying transport or changing globals.
 * Operations are present according to supportsOp. A host can narrow this
 * dynamic object to its supported subset of the framework's HostOps contract.
 */
export function mountUi(transport: UiTransport, environment: GuestEnvironment, global?: Record<string, any>): { ui: Record<string, any>; dispose(): void };
export function encodeUiString(value: unknown): Uint8Array;
export function decodeUiString(bytes: Uint8Array): string;

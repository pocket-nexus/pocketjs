export const NO_SELECTION: string;
export interface ExplicitSelection { readonly id: string; readonly origin: string }
export interface Selection extends ExplicitSelection { readonly source: "explicit" | "env" | "project" }
export function takeExplicitSelection(args: readonly string[], leading?: string):
  | { readonly args: string[]; readonly explicit: ExplicitSelection | null; readonly error?: undefined }
  | { readonly error: string };
export function select(input: {
  readonly explicit: ExplicitSelection | null;
  readonly env?: Record<string, string | undefined>;
  readonly project: { readonly config: string | null; readonly profiles: readonly { readonly id: string }[] } | null;
}): Selection | null;

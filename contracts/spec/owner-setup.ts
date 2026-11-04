// A companion service's owner setup: what the service declares it needs from
// its owner (SetupSpec), what `/<service>/_setup` answers (SetupState) and the
// changes it takes (SetupChange). Pocket Hub's tools/companion/setup.ts implements it for
// every service; a setup page in an applet reads these types.
//
//   GET  /<service>/_setup                         SetupState
//   POST /<service>/_setup {field, value}          set a field (checked against its pattern)
//   POST /<service>/_setup {field, clear: true}    forget it
//   POST /<service>/_setup {tool, consent: true}   accept the vendor's terms and fetch the tool
//   POST /<service>/_setup {tool, update: true}    fetch it again now (400 without the consent)
//   POST /<service>/_setup {tool, remove: true}    delete it and withdraw the consent
//
// Each POST answers the SetupState after the change; a refused change answers
// 400 with {error}. A service with no setup answers 404.
//
// Types only: this file imports nothing, so a consumer can `import type` it
// from a vendored copy of the repository.

/** A computer, as a vendor names its builds. */
export type Platform = "linux-arm64" | "linux-x64" | "linux-arm" | "darwin-arm64" | "darwin-x64";

/** A value the owner types once: a key from a vendor's dashboard, an instance URL. */
export interface SetupField {
  id: string;
  label: string;
  /** a key or a token: never answered, drawn as dots */
  secret: boolean;
  /** one line under the field */
  help?: string;
  /** where the owner gets the value */
  link?: { label: string; url: string };
  /** a regular expression the whole value matches */
  pattern?: string;
  maxLength?: number;
  optional?: boolean;
}

/** One platform's build of a vendor tool. */
export interface VendorBuild {
  url: string;
  /** how it is packed: a tar.gz or zip archive, or the program itself */
  archive: "tar.gz" | "zip" | "file";
  /** the program inside the archive, a path relative to the archive's root */
  binary: string;
  /** when the vendor's build is pinned */
  sha256?: string;
}

/** A vendor's own program the service runs, fetched on the owner's consent. */
export interface VendorTool {
  id: string;
  title: string;
  vendor: string;
  /** the vendor's terms the owner accepts by fetching it */
  terms: string;
  /** one line on what it is and why the service needs it */
  note?: string;
  builds: Partial<Record<Platform, VendorBuild>>;
  /** fetch it again once it is this many days old (a vendor's builds that expire) */
  refreshAfterDays?: number;
}

/** What a service declares it needs from its owner. */
export interface SetupSpec {
  title: string;
  fields?: SetupField[];
  tools?: VendorTool[];
}

/** Something the owner does elsewhere, shown while the service waits. */
export interface SetupPrompt {
  /** code: show `code` (and `url`) for the owner to confirm at a vendor's page;
   *  pick: pick this device in a vendor's app; wait: something is on its way */
  kind: "code" | "pick" | "wait";
  title: string;
  detail?: string;
  code?: string;
  url?: string;
  expiresAt?: number;
}

export type ToolState = "unavailable" | "absent" | "fetching" | "ready" | "failed";

/** A field as `/_setup` answers it: a secret's value is never in it. */
export interface SetupFieldState extends SetupField {
  set: boolean;
  /** a field that is not secret, as it is set */
  value?: string;
}

/** A vendor tool as `/_setup` answers it. */
export interface SetupToolState {
  id: string;
  title: string;
  vendor: string;
  terms: string;
  note?: string;
  state: ToolState;
  consented: boolean;
  /** bytes of the fetch in progress, or of the last one */
  received: number;
  /** the size the vendor announced; 0 when it announced none */
  total: number;
  fetchedAt: number | null;
  /** what is being fetched, or why the last fetch failed */
  message: string;
}

/** The answer of `GET /<service>/_setup`, and of every POST after its change. */
export interface SetupState {
  service: string;
  title: string;
  fields: SetupFieldState[];
  tools: SetupToolState[];
  prompt: SetupPrompt | null;
  /** every field that is not optional is set, and every tool is ready */
  ready: boolean;
}

/** A change `POST /<service>/_setup` takes. */
export type SetupChange =
  | { field: string; value: string }
  | { field: string; clear: true }
  | { tool: string; consent: true }
  | { tool: string; update: true }
  | { tool: string; remove: true };

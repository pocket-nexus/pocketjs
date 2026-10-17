// tools/targets/types.ts — the shape of a catalog entry.

import type { PlatformContractRegistry } from "../../contracts/spec/platforms.ts";
import type { ToolchainManifest } from "./toolchain.ts";

/** A machine a target's toolchain installs on. Windows hosts are unsupported. */
export type HostId = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64";

export const HOST_IDS: readonly HostId[] = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

export interface TargetDescriptor {
  /** The name `pocket` commands select a target by. */
  readonly id: string;
  readonly title: string;
  /** Where the target's platform contract lives. `target` is the contract
   *  target id plans and native hosts carry; it differs from `id` for device
   *  profiles (`3ds` → `3ds-dev`) and does not change with the catalog. */
  readonly contract: {
    readonly kind: "registry" | "profile";
    readonly target: string;
    readonly registry: () => PlatformContractRegistry;
  };
  /** Machines the target's toolchain installs on. */
  readonly hosts: readonly HostId[];
  /** The pinned components `pocket target add` installs. Absent for a target
   *  whose build script finds its own tools; empty for a target whose build is
   *  the compiler alone. */
  readonly toolchain?: ToolchainManifest;
}

/** The host this process runs on, or null for an unsupported machine. */
export function currentHost(platform: string = process.platform, arch: string = process.arch): HostId | null {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!os || !cpu) return null;
  return `${os}-${cpu}` as HostId;
}

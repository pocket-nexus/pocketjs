/** Evidence identity binding. Applications own measurements, camera policies and acceptance budgets. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const fileSha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
export interface DeviceIdentity {
  device: string;
  runtimeBuild: string;
  /** SHA-256 of the assets acknowledged/read back by this runtime. */
  assets: Record<string, string>;
}
function normalized(identity: DeviceIdentity): DeviceIdentity {
  if (!identity.device || !identity.runtimeBuild || !Object.keys(identity.assets).length)
    throw new Error("Device evidence needs device, runtime build and asset identities");
  const assets = Object.fromEntries(Object.entries(identity.assets).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  for (const [name, hash] of Object.entries(assets))
    if (!name || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid asset identity: ${name}`);
  return { device: identity.device, runtimeBuild: identity.runtimeBuild, assets };
}
export function assertDeviceIdentity(expected: DeviceIdentity, actual: DeviceIdentity): void {
  if (JSON.stringify(normalized(expected)) !== JSON.stringify(normalized(actual)))
    throw new Error("Device/runtime/assets changed during the evidence window");
}
export class DeviceEvidence<T> {
  readonly identity: DeviceIdentity;
  private observations: { recordedAt: string; value: T }[] = [];
  constructor(identity: DeviceIdentity) {
    this.identity = normalized(identity);
    Object.freeze(this.identity.assets);
    Object.freeze(this.identity);
  }
  observe(identity: DeviceIdentity, value: T): void {
    assertDeviceIdentity(this.identity, identity);
    this.observations.push({ recordedAt: new Date().toISOString(), value: structuredClone(value) });
  }
  receipt() {
    return structuredClone({ schemaVersion: 1, identity: this.identity, observations: this.observations });
  }
}

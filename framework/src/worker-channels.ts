// The UI domain's view of the worker's channels. The host bridge copies
// records into UI-owned mirrors before each frame and calls
// __pocketWorkerChannelFrame; the compiler's channel table maps names to IDs.
import { ResourceStatus, type WorkerDeclaration } from "../../contracts/spec/worker.ts";
import { ByteView } from "./byte-view.ts";
import { assertDomain } from "./domain.ts";

export { ByteView };
export type { WorkerChannelDeclaration } from "../../contracts/spec/worker.ts";

interface ChannelHost {
  configure(id: number, snapshot: number): number;
  publish(id: number, data: Uint8Array): number;
  observe(id: number): Uint8Array[];
}
type ChannelGlobal = typeof globalThis & { __pocketWorkerChannels?: ChannelHost; __pocketWorkerChannelFrame?: () => void };
declare const __POCKET_WORKER_DECLARATION__: WorkerDeclaration | null | undefined;

assertDomain("ui", "@pocketjs/framework/worker/channels");
let frame = 0;
(globalThis as ChannelGlobal).__pocketWorkerChannelFrame = () => { ++frame; };

function declaration(): WorkerDeclaration | undefined {
  return typeof __POCKET_WORKER_DECLARATION__ === "undefined" ? undefined : __POCKET_WORKER_DECLARATION__ ?? undefined;
}
function host(): ChannelHost {
  const bridge = (globalThis as ChannelGlobal).__pocketWorkerChannels;
  if (!bridge) throw new Error("No worker channel bridge in this realm: the host attaches it before evaluating the UI bundle");
  return bridge;
}

export const worker = {
  /** A declared channel: publish toward the worker, or observe the records
   *  the host mirrored for this frame. Views expire at the next frame. */
  channel(name: string) {
    const channels = declaration()?.channels ?? [];
    const id = channels.findIndex(channel => channel.name === name);
    if (id < 0) throw new Error(`Undeclared worker channel: ${name}`);
    const channel = channels[id];
    if (host().configure(id + 1, channel.kind === "snapshot" ? 1 : 0) !== ResourceStatus.ok) throw new Error(`Cannot configure worker channel ${name}`);
    return {
      publish(data: Uint8Array): boolean {
        if (channel.direction !== "ui-to-worker") throw new Error(`Channel ${name} is receive-only in the UI domain`);
        if (data.length > channel.recordBytes) throw new RangeError(`Channel ${name} record exceeds ${channel.recordBytes} bytes`);
        return host().publish(id + 1, data) === ResourceStatus.ok;
      },
      observe(): readonly ByteView[] {
        if (channel.direction !== "worker-to-ui") throw new Error(`Channel ${name} is publish-only in the UI domain`);
        const current = frame;
        return host().observe(id + 1).map(bytes => new ByteView(bytes, () => {
          if (frame !== current) throw new Error("Channel view expired; copy bytes before the next frame");
        }));
      },
    };
  },
};

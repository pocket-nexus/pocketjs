// @pocketjs/framework/worker: the worker realm's scheduler API. The runtime
// lives in worker-runtime.ts; this module is the domain-checked entry.
import { assertDomain } from "./domain.ts";

assertDomain("worker", "@pocketjs/framework/worker");

export { FactKind, ResourceStatus } from "../../contracts/spec/worker.ts";
export type { WorkerDeclaration, WorkerChannelDeclaration } from "../../contracts/spec/worker.ts";
export {
  OBSERVER_LIMIT, ResourceError, bindWorker, nowMicros, settle, sleep,
  wallClock, workerContext, workerDeclaration, workerHost,
} from "./worker-runtime.ts";
export type { FactRecord, HostFact, TimerTick, TurnContext, WallClock, WorkerHost } from "./worker-runtime.ts";

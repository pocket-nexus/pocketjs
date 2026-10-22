import { installEffectDriver } from "@pocketjs/framework/effects";
import { getOps } from "@pocketjs/framework/host";

type ServiceOps = {
  svcSend?: (line: string) => void;
};

/** Guest commands leave only through the frame-boundary service channel. */
export function installIPodTouchEffectDriver(): void {
  installEffectDriver((command, deliver) => {
    const ops = getOps() as ServiceOps;
    ops.svcSend?.(
      JSON.stringify({
        t: "cmd",
        id: command.id,
        kind: command.kind,
        payload: command.payload,
      }),
    );
    deliver(null);
  });
}

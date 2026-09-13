import { expect, test } from "bun:test";
import { createTextLayout } from "../framework/src/text-layout.ts";
import { runServicePumps } from "../framework/src/services.ts";

test("resident edits use one bounded job and canceled mutations force a fresh snapshot", () => {
  let generation = 1;
  const sent: any[] = [],
    replies: string[] = [],
    states: any[] = [];
  (globalThis as any).offload = {
    session: () => generation,
    submit(record: string) {
      expect(Buffer.byteLength(record)).toBeLessThanOrEqual(4096);
      const r = JSON.parse(record);
      r.data = JSON.parse(r.payload);
      sent.push(r);
      return true;
    },
    take: () => replies.shift(),
  };
  const doc = createTextLayout((s) => states.push(s));
  const deliver = (text: string) => {
    const request = sent.at(-1)!;
    replies.push(
      JSON.stringify({
        id: request.id,
        payload: JSON.stringify({
          revision: request.data.revision,
          rows: [{ row: 0, from: 0, to: text.length }],
          total: 1,
          next: null,
        }),
      }),
    );
    runServicePumps();
  };
  doc.update("😀 initial", { slot: 1, width: 400 });
  runServicePumps();
  expect(sent.map((r) => r.method)).toEqual(["text.replace"]);
  deliver("😀 initial");
  expect(states.at(-1).status).toBe("ready");
  doc.update("😃 initial", { slot: 1, width: 400 });
  runServicePumps();
  expect(sent.at(-1).method).toBe("text.edit");
  expect(sent.at(-1).data).toMatchObject({
    baseRevision: 1,
    revision: 2,
    from: 0,
    to: 2,
    text: "😃",
  });
  // The first edit may already have mutated the provider. A superseding edit
  // cannot use revision 1 as its base even though the old callback is canceled.
  doc.update("latest", { slot: 1, width: 400 });
  deliver("😃 initial");
  runServicePumps();
  expect(sent.at(-1).method).toBe("text.replace");
  deliver("latest");
  expect(
    states.filter((s) => s.status === "ready").map((s) => s.revision),
  ).toEqual([1, 3]);
  doc.update("reconnected", { slot: 1, width: 400 });
  runServicePumps();
  generation = 0;
  runServicePumps();
  generation = 2;
  runServicePumps();
  runServicePumps();
  expect(sent.at(-1).method).toBe("text.replace");
  deliver("reconnected");
  expect(states.at(-1).status).toBe("ready");
  doc.dispose();
  runServicePumps();
});

import { describe, expect, test } from "bun:test";
import { createOffloadClient, OFFLOAD } from "../framework/src/offload.ts";
import { OffloadDecoder, encodeOffloadRecord } from "../tools/offload-wire.ts";
import { dispatchOffload } from "../tools/offload-provider.ts";
import { sqliteQueries, httpResources } from "../tools/offload-capabilities.ts";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
function rig() {
  let session = 1;
  const sent: string[] = [], replies: string[] = [];
  const client = createOffloadClient({ session: () => session, submit: record => { sent.push(record); return true; }, take: () => replies.shift() });
  return { client, sent, replies, disconnect: () => session = -1, reconnect: () => session = 2 };
}
describe("offload budgets and failure delivery", () => {
  test("native SPSC concurrency, wrap and coverage decoder pass sanitizers", () => {
    const scratch = mkdtempSync(join(tmpdir(), "pocket-offload-"));
    try {
      const binary = join(scratch, "queue");
      const compile = Bun.spawnSync(["cc", "-std=c11", "-O2", "-pthread", "-fsanitize=address,undefined", resolve(import.meta.dir, "fixtures/offload-queue.c"), "-o", binary]);
      if (compile.exitCode) throw new Error(compile.stderr.toString());
      const run = Bun.spawnSync([binary]);
      if (run.exitCode) throw new Error(run.stderr.toString());
      expect(run.stdout.toString()).toContain("100000 SPSC records verified");
    } finally { rmSync(scratch, { recursive: true }); }
  });
  test("limits tickets, submissions and deliveries independently", () => {
    const r = rig(); let delivered = 0;
    for (let i = 0; i < 8; i++) expect(r.client.request("db.page", "{}", () => delivered++)).toBeGreaterThan(0);
    expect(r.client.request("db.page", "{}", () => {})).toBe(0);
    r.client.step(); expect(r.sent.length).toBe(2);
    for (const s of r.sent) r.replies.push(JSON.stringify({ id: JSON.parse(s).id, payload: "[]" }));
    r.client.step(); expect(delivered).toBe(1); expect(r.sent.length).toBe(4);
    r.client.step(); expect(delivered).toBe(2);
  });
  test("same-frame flush shares submission credits and never receives a second reply", () => {
    const r = rig(); let delivered = 0;
    const first = r.client.request("db.page", "first", () => delivered++);
    r.client.step(); expect(r.sent).toHaveLength(1);
    const second = r.client.request("db.page", "late", () => delivered++);
    r.client.request("db.page", "next-frame", () => delivered++);
    r.replies.push(JSON.stringify({ id: first, payload: "[]" }), JSON.stringify({ id: second, payload: "[]" }));
    r.client.flush(); r.client.flush();
    expect(r.sent).toHaveLength(2); expect(delivered).toBe(0);
    r.client.step(); r.client.flush(); r.client.flush();
    expect(r.sent).toHaveLength(3); expect(delivered).toBe(1);
    expect(r.replies).toHaveLength(1);
  });
  test("flush does not advance deadlines or dispatch expired queued requests", () => {
    const r = rig(); const results: unknown[] = [];
    r.disconnect();
    for (let i = 0; i < 3; i++) r.client.request("db.page", "{}", p => results.push(p));
    for (let i = 0; i < OFFLOAD.timeoutFrames - 1; i++) {
      r.client.step(); r.client.flush(); r.client.flush();
    }
    expect(results).toHaveLength(0);
    r.reconnect(); r.client.step(); r.client.flush();
    expect(results).toEqual([{ ok: false, error: "Provider unavailable" }]);
    expect(r.sent).toHaveLength(0);
    r.client.step(); r.client.flush(); expect(results).toHaveLength(2);
    r.client.step(); expect(results).toHaveLength(3); expect(r.client.pending()).toBe(0);
  });
  test("flush retains session guards until bounded error delivery", () => {
    const r = rig(); const results: unknown[] = [];
    r.client.step();
    for (let i = 0; i < 3; i++) r.client.request("file.save", "edit", p => results.push(p), { session: 1 });
    r.reconnect(); r.client.flush(); r.client.flush();
    expect(r.sent).toHaveLength(0); expect(results).toHaveLength(0);
    for (let i = 1; i <= 3; i++) {
      r.client.step(); r.client.flush();
      expect(results).toHaveLength(i); expect(r.sent).toHaveLength(0);
    }
  });
  test("realm pumps receive before planning and submit late-created clients in the same frame", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocket-offload-phases-"));
    const previous = (globalThis as any).offload;
    const sent: any[] = [], replies: string[] = [];
    let takes = 0, delivered = 0, plannedAfterDelivery = 0, frame = 0;
    const ops = { session: () => 1, take: () => { takes++; return replies.shift(); },
      submit: (raw: string) => { sent.push(JSON.parse(raw)); return true; } };
    (globalThis as any).offload = Object.assign(ops, { local: ops });
    let client: ReturnType<typeof createOffloadClient> | undefined, unregister: (() => void) | undefined;
    try {
      const build = await Bun.build({ entrypoints: [join(import.meta.dir, "fixtures/service-client-entry.ts")], outdir: directory, target: "bun" });
      expect(build.success).toBe(true);
      const { offload, registerServicePump, runServicePumps } = await import(build.outputs[0].path);
      // The planner predates its transport registration, and creates the client
      // after this frame's receive phase has already finished.
      unregister = registerServicePump(() => {
        if (frame === 0) {
          client = offload(); expect(offload("local")).toBe(client);
          for (let i = 0; i < 3; i++) client!.request("db.page", "{}", () => delivered++);
        } else if (frame === 1) {
          plannedAfterDelivery = delivered;
          client!.request("db.page", "planned-after-reply", () => delivered++);
        }
        frame++;
      });
      runServicePumps(); expect(sent).toHaveLength(2); expect(takes).toBe(0);
      for (const request of sent) replies.push(JSON.stringify({ id: request.id, payload: "[]" }));
      runServicePumps();
      expect(plannedAfterDelivery).toBe(1); expect(takes).toBe(1);
      expect(sent).toHaveLength(4); expect(delivered).toBe(1);
      client!.flush(); expect(sent).toHaveLength(4); expect(takes).toBe(1);
      runServicePumps(); expect(takes).toBe(2); expect(delivered).toBe(2);
    } finally {
      unregister?.(); client?.dispose();
      if (previous === undefined) delete (globalThis as any).offload; else (globalThis as any).offload = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test("does not replay sent mutations or deliver old connection results", () => {
    const r = rig(); const results: unknown[] = [];
    const id = r.client.request("file.save", "edit", p => results.push(p));
    r.client.step(); r.disconnect(); r.client.step();
    expect(results).toHaveLength(1); expect(results[0]).toMatchObject({ ok: false });
    r.reconnect(); r.replies.push(JSON.stringify({ id, payload: "saved" })); r.client.step();
    expect(r.client.session()).toBe(2);
    expect(results).toHaveLength(1); expect(r.sent).toHaveLength(1);
  });
  test("cancellation, timeout and malformed records leave bounded state", () => {
    const r = rig(); let delivered = 0;
    const id = r.client.request("slow.query", "{}", () => delivered++);
    r.client.cancel(id); r.client.step(); expect(r.sent).toHaveLength(0);
    r.client.request("slow.query", "{}", () => delivered++);
    r.replies.push("{bad");
    for (let i = 0; i <= OFFLOAD.timeoutFrames; i++) r.client.step();
    expect(delivered).toBe(1); expect(r.client.pending()).toBe(0);
    expect(() => r.client.request("db.page", "中".repeat(2500), () => {})).toThrow();
  });
  test("UTF-8 records survive every split and reject oversized length immediately", () => {
    const record = JSON.stringify({ text: "文档 😀" }), bytes = encodeOffloadRecord(record);
    for (let split = 0; split <= bytes.length; split++) {
      const decoder = new OffloadDecoder(), out: string[] = [];
      decoder.push(bytes.subarray(0, split), s => out.push(s)); decoder.push(bytes.subarray(split), s => out.push(s));
      expect(out).toEqual([record]);
    }
    expect(() => new OffloadDecoder().push(Buffer.from([0, 0, 16, 1]), () => {})).toThrow();
  });
  test("provider enforces grants and reply budgets", async () => {
    expect(await dispatchOffload({}, { v: 1, id: 1, method: "constructor", payload: "" })).toHaveProperty("error");
    expect(await dispatchOffload({ large: () => "x".repeat(3000) }, { v: 1, id: 2, method: "large", payload: "" })).toHaveProperty("error");
    expect(await dispatchOffload({ query: () => "[]" }, { v: 1, id: 3, method: "query", payload: "" })).toEqual({ id: 3, payload: "[]" });
  });
  test("SQLite query grants accept values and reject unbounded results", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE notes(id INTEGER, title TEXT); INSERT INTO notes VALUES(1,'hello'),(2,'world')");
    const methods = sqliteQueries(db, { find: "SELECT title FROM notes WHERE id=? LIMIT 1", large: "SELECT hex(zeroblob(2000))" });
    expect(methods.find("[2]")).toBe('[{"title":"world"}]');
    expect(() => methods.large("[]")).toThrow("bounded page");
    expect(() => methods.find('{"sql":"DROP TABLE notes"}')).toThrow();
    db.close();
  });
  test("HTTP grants reject redirects and stop oversized streams", async () => {
    const server = Bun.serve({ port: 0, fetch: r => new URL(r.url).pathname === "/redirect" ? Response.redirect("https://example.com") : new Response(new URL(r.url).pathname === "/big" ? "x".repeat(3000) : "remote data") });
    try {
      const m = httpResources({ small: `${server.url}small`, big: `${server.url}big`, redirect: `${server.url}redirect` });
      expect(await m.small("")).toBe("remote data");
      await expect(m.big("")).rejects.toThrow(); await expect(m.redirect("")).rejects.toThrow();
    } finally { server.stop(true); }
  });
});

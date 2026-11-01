// The companion's store for an applet's small settings: a subscription list,
// a chosen city, a home's address and token. An applet keeps what must
// outlive its realm here, one JSON document per name under
// `<storeDir>/services/store/`, and reads it back when it starts.
//
//   GET  /get?name=<name>        {value} or {value: null}
//   POST /set?name=<name>        body: the JSON value (at most 64 KiB) → {ok: true}
//   POST /delete?name=<name>     → {ok: true}
//   GET  /list                   {names: [...]}
//
// A name is the applet's own (`weather`, `podcasts/subscriptions`): letters,
// digits, dots, dashes and one level of `/`. A credential kept here never
// leaves the companion but to the applet that stored it; the files are the
// owner's, mode 600.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonResponse, type ServiceContext, type ServiceProvider, type ServiceRequest } from "../services.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
const VALUE_MAX = 64 * 1024;

export function createStoreService(context: ServiceContext): ServiceProvider {
  const dir = join(context.storeDir, "services", "store");
  const file = (name: string) => join(dir, `${name}.json`);
  const named = (request: ServiceRequest): string | null => {
    const name = request.query.get("name") ?? "";
    return NAME.test(name) ? name : null;
  };
  return {
    name: "store",
    async handle(request) {
      switch (request.path) {
        case "/get": {
          const name = named(request);
          if (!name) return jsonResponse(400, { error: "get needs a name" });
          const path = file(name);
          if (!existsSync(path)) return jsonResponse(200, { value: null });
          try {
            return jsonResponse(200, { value: JSON.parse(readFileSync(path, "utf8")) });
          } catch {
            return jsonResponse(200, { value: null });
          }
        }
        case "/set": {
          const name = named(request);
          if (!name) return jsonResponse(400, { error: "set needs a name" });
          if (request.body.length > VALUE_MAX) return jsonResponse(413, { error: "the value is over 64 KiB" });
          let value: unknown;
          try {
            value = JSON.parse(new TextDecoder().decode(request.body));
          } catch {
            return jsonResponse(400, { error: "the value is not JSON" });
          }
          const path = file(name);
          mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
          writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
          return jsonResponse(200, { ok: true });
        }
        case "/delete": {
          const name = named(request);
          if (!name) return jsonResponse(400, { error: "delete needs a name" });
          rmSync(file(name), { force: true });
          return jsonResponse(200, { ok: true });
        }
        case "/list": {
          if (!existsSync(dir)) return jsonResponse(200, { names: [] });
          const names: string[] = [];
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith(".json")) names.push(entry.name.slice(0, -5));
            else if (entry.isDirectory()) {
              for (const inner of readdirSync(join(dir, entry.name))) {
                if (inner.endsWith(".json")) names.push(`${entry.name}/${inner.slice(0, -5)}`);
              }
            }
          }
          return jsonResponse(200, { names: names.sort() });
        }
        default:
          return jsonResponse(404, { error: `no store endpoint ${request.path}` });
      }
    },
    async state() {
      return { entries: existsSync(dir) ? readdirSync(dir).length : 0 };
    },
  };
}

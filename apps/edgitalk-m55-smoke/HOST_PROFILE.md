# Host profile note — `edgitalk-m55`

Canonical file: [`pocket.host.json`](./pocket.host.json).

## Current values (do not invent a fake schema)

| Field | Value |
| --- | --- |
| `$schema` | `https://pocketjs.dev/schema/pocket-idf-host-1.json` |
| `platform` | `"esp-idf"` |
| `id` | `edgitalk-m55` |
| `form` | `takeover` |
| `tickHz` | `30` |
| display | physical 800×480, logical 400×240 @ density 2, `native` |
| capabilities | `input.touch`, `text.glyphs.baked` |

This is an intentional **borrow** of the ESP-IDF host admission shape so the
Pocket CLI and package `PHST` checks work on RT-Thread / Edgi-Talk today. The
firmware is **not** ESP-IDF.

## CLI / build

Pocket CLI does **not** yet register `platform: "rt-thread"`. Build with the IDF
host profile borrow:

```sh
bun tools/pocket.ts build \
  --host-profile apps/edgitalk-m55-smoke/pocket.host.json \
  --manifest apps/edgitalk-m55-smoke/pocket.json
```

Admission path: same as ESP (`pocketjs_package_select` + HostOps / viewport /
tick / density / presentation / profile hash). See host docs:
[`hosts/rt-thread-edgitalk/docs/build.md`](../../hosts/rt-thread-edgitalk/docs/build.md).

## Product natives (`__edgi`)

[`native.ts`](./native.ts) talks to firmware `__edgi` (dashboard, music, game,
Wi-Fi/BT bridges). That stays **outside** PocketJS core — product installs it on
the guest `JSContext`, same philosophy as ESP product extensions. Overlay owns
the C side (`pocketjs_dashboard*`, wifi/bt/game/synth/music).

## Tracking

Keep `platform: "esp-idf"` until a real RT-Thread host schema exists
(working name: `pocket-rtt-host-1` / `platform: "rt-thread"`).

**Issue:** https://github.com/1024971823/pocketjs/issues/2

Host tree: [`hosts/rt-thread-edgitalk/`](../../hosts/rt-thread-edgitalk/).

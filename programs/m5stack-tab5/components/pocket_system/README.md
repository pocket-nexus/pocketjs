# pocket_system

The system services of the Tab5 as a launcher console: installed apps and
switching between them, the Pocket Link to a paired companion, `net.http`
through the companion, a guest's `data.fs` tree and the Wi-Fi radio.

- Public header: `pocket/system.h`
- Shared state machines: `engine/host-services` (`link.c`, `launcher.c`,
  `fs.c`), compiled from the repository
- `esp_wifi` comes from `espressif/esp_wifi_remote` and `espressif/esp_hosted`,
  which the program lists with its coprocessor's pins

## Store

`pocketjs_system_start` takes one mounted directory:

| Path | Contents |
| --- | --- |
| `link/` | the device id and one file per paired companion |
| `apps/<slot>/package.pocket` | the slot's installed package; its hash is the file's footer |
| `apps/<slot>/app.txt` | the launcher's cached facts (output, id, title, version) |
| `apps/<slot>/data/` | the guest's `data.fs` tree, quota from `applet.store` |

`<slot>` is the first 16 hex digits of SHA-256 of the app id. An install
streams into `apps/<slot>/link-upload.pocket`, is admitted
(`pocket_idf_package_open`: footer, FNV-1a64, a variant for the firmware's
profile and binding generation) and replaces `package.pocket`.
`pocketjs_system_mount_flash` mounts a wear-levelled FAT partition when no
card is available.

## Guest lifecycle

The program loads the launcher (`pocketjs_system_load_launcher`), creates the
guest, calls `pocketjs_system_bind` with its realm and boots the runtime
with the app's bytes as its package source. Each tick, before the turn, it
calls `pocketjs_system_pump`; SELECT outside the launcher calls
`pocketjs_system_summon`. When `pocketjs_system_switch_pending` becomes true,
the program stops the runner, destroys the runtime and guest, calls
`pocketjs_system_unbind`, takes the target with `pocketjs_system_take_switch`
and boots it.

## Guest namespaces

| Global | Contract |
| --- | --- |
| `ui.appTable`, `ui.appLaunch`, `ui.appShot` | the `applications` operations, served by the program's operation provider from `pocketjs_system_app_table` and `pocketjs_system_launch` |
| `link` | `contracts/spec/link.ts` |
| `net` | `contracts/spec/net.ts` over the link |
| `wifi` | `contracts/spec/wifi.ts`, with `scan`, `join` and `forget` |
| `fs` | `contracts/spec/fs.ts`, when the plan's features hold `data.fs` |

The radio keeps three saved networks in NVS (namespace `pocketwifi`), joins
the most recently used at start, and saves a joined network once it has an
address. Storage and NVS are flash, so every call runs on one task with an
internal stack while the guest's task waits. A scan start, a scan result and
an RSSI read each cross the SDIO link to the ESP32-C6 and wait for its answer:
the `pocketjs_radio` task (8 KB, internal RAM) makes those calls, a scan when
the guest asked for one (`scan_requested`, `scan_done`) and the RSSI read on
an interval while connected; `status` answers from the cached state without
touching the link.

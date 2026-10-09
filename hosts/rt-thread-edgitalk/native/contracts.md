# Native contracts — Edgi-Talk M55

M55 links the **same** GuestOps/HostOps and UI/render C↔Rust layouts as
`hosts/esp-idf`. Do not maintain a forked field list.

| Surface | Source of truth | Check |
| --- | --- | --- |
| UI / RGB565 structs + fns | `contracts/spec/idf-native.ts` → `tools/esp-idf-contracts.ts` | Shared |
| Package format / PHST | `contracts/spec/pocket-package.ts` | Shared |
| RTT inventory + TODOs | `contracts/spec/rtt-edgitalk-native.ts` | `bun tools/rt-thread-edgitalk-contracts.ts --list` |
| Shared freshness | (reuse IDF generator) | `bun tools/rt-thread-edgitalk-contracts.ts --check` |

`--check` verifies shared generated headers match the IDF spec, then prints
RTT-only items as **not yet enforced** (shims, board hooks, `platform` id).
It never claims a green pass for those.

Platform / CLI registration: https://github.com/1024971823/pocketjs/issues/2

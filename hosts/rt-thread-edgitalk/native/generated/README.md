# Embedded `.pocket` package pattern

Product firmware embeds the built container as a rodata blob (`.incbin`) plus a
small C descriptor with the host contract. **Do not vendor huge generated blobs
into this monorepo** — regenerate in the product tree (or CI) after UI changes.

## Files (Edgi smoke naming)

| File | Role |
| --- | --- |
| `pocketjs_package_<name>.h` | Declares `pocketjs_embedded_package_t` + `pocketjs_package_host_contract_t` |
| `pocketjs_package_<name>.c` | Fills `.data` / `.size` and the contract from `pocket.host.json` |
| `pocketjs_package_<name>_blob.S` | `.incbin` of `apps/.../dist/<name>.pocket` (path must be build-relative) |

## Regenerate

From the **pocketjs** repo root:

```sh
bun tools/pocket.ts build \
  --host-profile apps/edgitalk-m55-smoke/pocket.host.json \
  --manifest apps/edgitalk-m55-smoke/pocket.json
```

Then refresh the assembly `.incbin` path to that `.pocket` (prefer a path
relative to the product build tree or an absolute path computed in SCons — never
commit a machine-specific `/home/...` path as the long-term SoT).

Update the `.c` contract fields (`tick_hz`, logical/physical size, density,
`profile_hash`, `target_id`) to match the host profile. The overlay historically
kept these under `applications/pocketjs/generated/`.

## Stub in this tree

`pocketjs_package_stub.{h,c}` is a **zero-size placeholder** so the host
`SConscript` links. The product must supply a real package via:

1. Board hooks `pocketjs_board_embedded_package` / `pocketjs_board_host_contract`, or
2. Dropping real `pocketjs_package_edgitalk_smoke.{c,_blob.S}` next to this README
   (the host `SConscript` auto-prefers those when both exist).

See also [`../README.md`](../README.md) and issue
[#2](https://github.com/1024971823/pocketjs/issues/2) (host platform identity).

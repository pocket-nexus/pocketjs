## Terminal

```sh
bun install
bun microts/compiler/cli.ts build vue-sfc-lab --strict
cargo check --manifest-path apps/vue-sfc-lab/Cargo.toml

# browser preview through the web host
rustup target add wasm32-unknown-unknown
bun tools/dev.ts vue-sfc-lab-main --framework=vue-vapor --no-config
```

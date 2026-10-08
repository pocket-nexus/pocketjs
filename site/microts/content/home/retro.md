## game.ts

```ts
import { system, screen, input } from "retro";
import { imod, type i32 } from "@pocketjs/framework/solid/std";

let x: i32 = 20;

export function setup(): void {
  system.init(160, 120);
}

export function update(): void {
  if (input.btn(input.key.RIGHT)) x++;
  if (input.btn(input.key.LEFT)) x--;
}

export function draw(): void {
  screen.cls(1);
  screen.rect(x, 40, 30, 20, imod(system.frameCount(), 16));
  screen.circ(120, 30, 12, 8);
  screen.text(5, 5, "HELLO POCKET RETRO", 7);
}
```

## Build

```sh
# The game, the SDK and a generated root module compile as one MicroTS model
bun tools/build.ts games/jump              # → dist/jump.gba
bun tools/run.ts dist/jump.gba --frames=300 --shot=jump.png
```

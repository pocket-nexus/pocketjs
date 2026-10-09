## Build

```sh
# In a pocket-retro checkout: build one ROM from the
# game and the SDK, compiled as one MicroTS model
bun tools/build.ts games/{{game}}
# → dist/{{game}}.gba, for a GBA emulator or a flash cart

# Run the ROM in a headless mGBA and save a screenshot
bun tools/run.ts dist/{{game}}.gba \
  --frames=300 --shot={{game}}.png
```

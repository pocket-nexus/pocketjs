# Vapor Quest pixel art

This folder is the reviewed visual source for the GBA RPG POC. PixelLab creates
the source PNGs; the offline asset compiler fixes their dimensions, transparent
anchors and GBA palettes before emitting the reviewed sheets in `final/` and
`vapor/runtime/gba/vapor_rpg_assets.generated.h`.

## Art bible

- Bright field, deep-navy information layer, expressive close-up chibi silhouettes.
- Native hard pixels, no antialiasing, gradients, dithering or partial alpha.
- Lighting always comes from the top left; visible outlines use `#18294a`.
- Logical world cells are 16x16 metatiles, so the 240x160 screen shows a
  camera-followed 15x10 slice of the map. UI pieces remain screen-space 8x8.
- World OBJ frames are 32x32 with a shared y=31 foot line. Battle derives
  readable 64x64 close-up frames from the same reviewed PixelLab sources.
- The hero has four reviewed walking frames in each cardinal direction. Each
  direction shares one scale and horizontal anchor, while every contacting
  foot is normalized to y=31 so movement stays grounded without sprite jitter.
- The SLIME gameplay role uses a compact teal tentacled puddle-ooze silhouette;
  its short pseudopods, two white eyes and broad ground contact are intentional.
- Generated terrain luminance clusters remain the base texture; deterministic
  material ramps and sparse accents make them legible in one fixed 4bpp bank.
- World/UI, hero, elder and slime each have one fixed 4bpp palette bank.
- Flowers remain low-contrast walkable decoration; walls, water and trees read
  as barriers. UI texture remains quieter and higher contrast than the world.

`generation.json` records the exact PixelLab endpoints, prompts, seeds, IDs and
source hashes. It intentionally contains no API token.

## Rebuild

Source generation is opt-in because it consumes PixelLab quota and replaces
reviewed art:

```sh
set -a
source ~/code/.env
set +a
bun run vapor:rpg:assets:generate --force --only=all
```

The normal build and CI paths are entirely offline:

```sh
bun run vapor:rpg:assets:build
bun run vapor:rpg:assets:check
```

Do not hand-edit the generated header. Review `background.png`, `actors.png`,
the 4x4 `hero-walk.png` cycle sheet, `battle-actors.png`, the palette guide,
and the world/dialog/battle mGBA captures after changing any source image.

Use `--only=style`, `--only=world`, `--only=tree`, `--only=flower`,
`--only=characters`, `--only=hero`, `--only=walk`, `--only=elder` or
`--only=slime` with `--force` for a targeted iteration. The walk generator
reuses the persistent PixelLab hero and its `walking-4-frames` skeleton
template. Without `--force`, generation only fills missing sources.

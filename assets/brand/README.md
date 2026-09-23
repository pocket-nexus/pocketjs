# PocketJS Brand Avatars

The **yellow shell is the outer silhouette**, with a plum interior, pink lens
and short key, and cyan long key. The drawing comes from
`site/assets/favicon.svg`. There is no outer capsule or shadow.

The **1024×1024 JPG exports** use the same centered mark and framing:

- [White background](pocketjs-avatar-white.jpg): `#ffffff`.
- [Dark background](pocketjs-avatar-dark.jpg): `#171226`.

The existing `white-minimal`, `white-plate`, and `white-polished` SVG/PNG
filenames retain their mark sizes for package consumers. All use the favicon
drawing without an outer capsule. The `white-plate` variant has extra margin
for circular crops.

Regenerate the SVG, PNG, and JPG exports with `bun tools/generate-brand.ts`.
Run `bun tools/generate-brand.ts --check` to compare the committed files with
the generator output.

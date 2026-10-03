# Device desk scene attribution

The composition, environment geometry, generic desktop monitor, generic Android
handset, and iPod touch 4 approximation are authored by
`tools/desk-scene/build.py` in this repository.
The supplied user mockup is a composition reference and is not embedded in the
scene, textures, or repository.

- **PSP:** “PlayStation Portable (PSP) - EG02” by **Dibad**,
  [source model](https://sketchfab.com/3d-models/playstation-portable-psp-eg02-b76c7f9158204a39929a9c97d0b813d0),
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  This scene uses the repository's interactive optimized derivative, separates
  it by material, normalizes its orientation and dimensions, removes its screen
  glass overlay, replaces its screen with a blank material, and applies the
  existing monochrome semantic to hardware markings.
  See the [source attribution](../../../engine/pocket3d/examples/handheld/assets/dibad-psp/ATTRIBUTION.md).
- **New Nintendo 3DS and PS Vita:** repository-authored Blender assets, reused
  with their original geometry, hardware marks, and editable components. The
  scene changes placement, the 3DS hinge pose, and display materials.
  See [3DS attribution](../../../engine/pocket3d/examples/handheld/assets/new-nintendo-3ds/ATTRIBUTION.md)
  and [Vita attribution](../../../engine/pocket3d/examples/handheld/assets/ps-vita-2000/ATTRIBUTION.md).
- **iPod reference:** [Apple iPod touch 4 technical specifications](https://support.apple.com/en-us/112431).
  Envelope and display dimensions follow this source; small feature placement
  and material appearance are approximations. No downloaded Apple mesh or image
  is included.
- The appended console lettering uses Blender's built-in Bfont. See the
  [existing Bfont license](../../../engine/pocket3d/examples/handheld/assets/ps-vita-2000/BFONT-LICENSE.txt).

Hardware names and marks belong to their respective owners.

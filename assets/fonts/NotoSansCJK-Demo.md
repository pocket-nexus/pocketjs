# Noto Sans CJK demo subset

`NotoSansCJK-Demo.otf` is a maintained fixture consumed by `tests/font-config.test.ts`
and the archive, batch and Text Lab tests. The PSP Text Lab uses the full external archive
prepared by `tools/text-lab-assets.ts`. The SIL Open Font License is in
`LICENSE-NotoSansCJK.txt`.

Source: [NotoSansCJKjp-Regular.otf](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf)
at commit `f8d157532fbfaeda587e826d4cd5b21a49186f7c`.
Source SHA-256: `68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5`.

The subset contains the historical runtime-metadata fixture characters and ranges
U+3000–30FF, U+4E00–4EFF and U+FF61–FF9F that the source font covers. The downstream
player regression adds U+FF11 (１), U+FF21 (Ａ) and U+20BB7 (𠮷). It retains
OpenType layout tables and names. It provides one Japanese font rendition;
it does not select regional Han glyph variants by language.

To reproduce with fontTools, create a UTF-8 file containing the union of those
characters (read the subset cmap to recover its exact coverage) and run:

```sh
pyftsubset NotoSansCJKjp-Regular.otf --text-file=subset.txt --output-file=NotoSansCJK-Demo.otf --layout-features='*' --name-IDs='*' --name-languages='*' --name-legacy
```

Subset SHA-256: `0531cf07fbc20e42b7b61b25f131932114004618695dc9960e0ec85a9595183e`.

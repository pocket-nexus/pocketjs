# Runtime font fixture

`NotoSansSC-Test.ttf` is a static TrueType subset of [Noto Sans SC](https://github.com/google/fonts/blob/2894aab31764f10f29c421bdfd2340d3b382d384/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf), distributed under the adjacent OFL license. Its family name is `Pocket CJK Test`.

Source SHA-256: `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`.

The fixture contains U+4E00–U+4FFF plus the characters in `你好世界汉字文本字体运行时测试大量新增缓存字号动态颜色连续编辑`. FontTools subsets the source before instantiating the weight axis at 400; the output contains `glyf` and `loca`, with no `fvar`. Name IDs 1, 2, 4, 6, 16 and 17 identify the test family and Regular style. Tests use this face to exercise explicit fallback, new Han glyphs and bounded cache pressure without a system font dependency.

`NotoSans-Ligature.ttf` is the `Pocket Ligature Test` family, derived from [Noto Sans](https://github.com/google/fonts/blob/2984c575fdce412ee02b2baaba67672b9a9434d8/ofl/notosans/NotoSans%5Bwdth,wght%5D.ttf), source SHA-256 `bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d`. FontTools retains U+0020–U+00FF and U+0300–U+036F, including layout-feature closure, then instantiates weight 400 and width 100. The adjacent `OFL-NotoSans.txt` applies. This fixture supplies a real `ffi` ligature; the shipped Inter and JetBrains Mono faces do not supply that ligature.

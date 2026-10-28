// pocket-glyphs — the console agent's glyphs, rasterized with FreeType: the
// Linux counterpart of tools/companion/macos/Glyphs.swift, same protocol.
//
//   pocket-glyphs <pixel size> <cell width> <cell height> <baseline> [bold]
//
// stdin   one request per line: codepoints as decimal numbers, comma-separated
// stdout  one JSON line per request:
//         {"glyphs":[{"cp":N,"advance":A,"xoff":X,"coverage":"<base64>"}, …]}
//         coverage is cellW x cellH alpha bytes, top row first, the baseline
//         `baseline` px below the cell's top. A codepoint no font can draw is
//         left out (the atlas maps it to its tofu box).
//
// The face is fontconfig's sans-serif for Simplified Chinese (Noto Sans CJK
// SC on Debian), bold with `bold`; a codepoint it lacks takes the first
// font fontconfig sorts for it. Colour fonts are left out: their glyphs are
// bitmaps at one fixed size. Antialiased, no hinting beyond FreeType's
// default: plain coverage.
//
// Build: cc -O2 glyphs.c -o pocket-glyphs $(pkg-config --cflags --libs freetype2 fontconfig)

#include <fontconfig/fontconfig.h>
#include <ft2build.h>
#include FT_FREETYPE_H
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { MAX_FACES = 16, MAX_LINE = 1 << 16 };

static FT_Library library;
static int size, cell_w, cell_h, baseline, bold;
static struct {
  char file[512];
  int index;
  FT_Face face;
} faces[MAX_FACES];
static int face_count;
static FT_Face base;

static FT_Face open_face(const char *file, int index) {
  for (int i = 0; i < face_count; i++)
    if (faces[i].index == index && strcmp(faces[i].file, file) == 0) return faces[i].face;
  FT_Face face;
  if (FT_New_Face(library, file, index, &face)) return NULL;
  if (FT_HAS_COLOR(face) || FT_Set_Pixel_Sizes(face, 0, size)) {
    FT_Done_Face(face);
    return NULL;
  }
  if (face_count < MAX_FACES) {
    snprintf(faces[face_count].file, sizeof faces[face_count].file, "%s", file);
    faces[face_count].index = index;
    faces[face_count].face = face;
    face_count++;
  }
  return face;
}

/* The face fontconfig gives `pattern`, with the bold weight when asked. */
static FT_Face match(FcPattern *pattern) {
  FcPatternAddInteger(pattern, FC_WEIGHT, bold ? FC_WEIGHT_BOLD : FC_WEIGHT_REGULAR);
  FcPatternAddBool(pattern, FC_COLOR, FcFalse);
  FcConfigSubstitute(NULL, pattern, FcMatchPattern);
  FcDefaultSubstitute(pattern);
  FcResult result;
  FcPattern *found = FcFontMatch(NULL, pattern, &result);
  FT_Face face = NULL;
  FcChar8 *file;
  int index = 0;
  if (found && FcPatternGetString(found, FC_FILE, 0, &file) == FcResultMatch) {
    FcPatternGetInteger(found, FC_INDEX, 0, &index);
    face = open_face((const char *)file, index);
  }
  if (found) FcPatternDestroy(found);
  return face;
}

/* The face that draws `cp`: the base face, else the font fontconfig picks
 * for a pattern holding only that character. */
static FT_Face face_for(unsigned cp) {
  if (base && FT_Get_Char_Index(base, cp)) return base;
  FcPattern *pattern = FcPatternCreate();
  FcCharSet *set = FcCharSetCreate();
  FcCharSetAddChar(set, cp);
  FcPatternAddCharSet(pattern, FC_CHARSET, set);
  FcPatternAddString(pattern, FC_LANG, (const FcChar8 *)"zh-cn");
  FT_Face face = match(pattern);
  FcCharSetDestroy(set);
  FcPatternDestroy(pattern);
  return face && FT_Get_Char_Index(face, cp) ? face : NULL;
}

static void base64(const unsigned char *in, size_t n) {
  static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (size_t i = 0; i < n; i += 3) {
    unsigned v = in[i] << 16 | (i + 1 < n ? in[i + 1] << 8 : 0) | (i + 2 < n ? in[i + 2] : 0);
    putchar(table[v >> 18 & 63]);
    putchar(table[v >> 12 & 63]);
    putchar(i + 1 < n ? table[v >> 6 & 63] : '=');
    putchar(i + 2 < n ? table[v & 63] : '=');
  }
}

/* One glyph's JSON object; false when no font draws `cp`. */
static int glyph(unsigned cp, int first) {
  FT_Face face = face_for(cp);
  if (!face || FT_Load_Char(face, cp, FT_LOAD_RENDER | FT_LOAD_TARGET_NORMAL)) return 0;
  FT_GlyphSlot slot = face->glyph;
  FT_Bitmap *bitmap = &slot->bitmap;
  if (bitmap->pixel_mode != FT_PIXEL_MODE_GRAY && bitmap->rows && bitmap->width) return 0;
  /* Ink left of the pen moves right into the cell; the renderer draws the
   * cell xoff px left of the pen. */
  int xoff = slot->bitmap_left < 0 ? -slot->bitmap_left : 0;
  unsigned char *pixels = calloc((size_t)cell_w * cell_h, 1);
  if (!pixels) return 0;
  for (unsigned row = 0; row < bitmap->rows; row++) {
    int y = baseline - slot->bitmap_top + (int)row;
    if (y < 0 || y >= cell_h) continue;
    for (unsigned col = 0; col < bitmap->width; col++) {
      int x = xoff + slot->bitmap_left + (int)col;
      if (x < 0 || x >= cell_w) continue;
      pixels[y * cell_w + x] = bitmap->buffer[row * bitmap->pitch + col];
    }
  }
  int advance = (int)((slot->advance.x + 32) >> 6);
  if (advance < 0) advance = 0;
  if (advance > cell_w) advance = cell_w;
  printf("%s{\"cp\":%u,\"advance\":%d,\"xoff\":%d,\"coverage\":\"", first ? "" : ",", cp, advance, xoff > 255 ? 255 : xoff);
  base64(pixels, (size_t)cell_w * cell_h);
  printf("\"}");
  free(pixels);
  return 1;
}

int main(int argc, char **argv) {
  if ((argc != 5 && !(argc == 6 && strcmp(argv[5], "bold") == 0))) {
    fprintf(stderr, "usage: pocket-glyphs <pixel size> <cell width> <cell height> <baseline> [bold]\n");
    return 2;
  }
  size = atoi(argv[1]);
  cell_w = atoi(argv[2]);
  cell_h = atoi(argv[3]);
  baseline = atoi(argv[4]);
  bold = argc == 6;
  if (size <= 0 || cell_w <= 0 || cell_h <= 0 || cell_w > 255 || cell_h > 255) {
    fprintf(stderr, "pocket-glyphs: bad cell\n");
    return 2;
  }
  if (!FcInit() || FT_Init_FreeType(&library)) {
    fprintf(stderr, "pocket-glyphs: no fontconfig or FreeType\n");
    return 1;
  }
  FcPattern *pattern = FcNameParse((const FcChar8 *)"sans-serif:lang=zh-cn");
  base = match(pattern);
  FcPatternDestroy(pattern);
  static char line[MAX_LINE];
  while (fgets(line, sizeof line, stdin)) {
    printf("{\"glyphs\":[");
    int first = 1;
    for (char *at = line; *at;) {
      char *end;
      unsigned long cp = strtoul(at, &end, 10);
      if (end == at) {
        at++;
        continue;
      }
      if (cp > 0 && cp <= 0x10ffff && glyph((unsigned)cp, first)) first = 0;
      at = end;
    }
    printf("]}\n");
    fflush(stdout);
  }
  return 0;
}

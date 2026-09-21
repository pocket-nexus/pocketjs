/* One worker owns these faces. Font bytes and rendered outlines never enter UI threads. */
#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_OUTLINE_H
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif
struct pocket_face { FT_Library library; FT_Face face; unsigned char *source; };
EXPORT void *pocket_ft_face(const unsigned char *bytes, uint32_t length) {
    if (!length || length > 32*1024*1024) return NULL;
    struct pocket_face *p = calloc(1, sizeof(*p));
    if (!p) return NULL;
    p->source = malloc(length);
    if (!p->source) { free(p); return NULL; }
    memcpy(p->source, bytes, length);
    if (FT_Init_FreeType(&p->library) || FT_New_Memory_Face(p->library, p->source, length, 0, &p->face)) {
        if (p->library) FT_Done_FreeType(p->library);
        free(p->source); free(p); return NULL;
    }
    return p;
}
EXPORT void pocket_ft_drop(void *handle) {
    struct pocket_face *p = handle;
    if (!p) return;
    FT_Done_Face(p->face); FT_Done_FreeType(p->library); free(p->source); free(p);
}
EXPORT int pocket_ft_render(void *handle, uint32_t size64, uint32_t glyph, int32_t *info) {
    struct pocket_face *p = handle;
    if (!p || !info || size64 < 256 || size64 > 16384) return -1;
    FT_Error err = FT_Set_Char_Size(p->face, 0, size64, 72, 72);
    if (err) return err;
    /* Unhinted advances come from the shaper. Bitmap residency cannot change geometry. */
    err = FT_Load_Glyph(p->face, glyph, FT_LOAD_NO_HINTING | FT_LOAD_NO_BITMAP);
    if (err) return err;
    /* Bound the destination before FreeType allocates its coverage buffer. */
    if (p->face->glyph->format == FT_GLYPH_FORMAT_OUTLINE) {
        FT_BBox box;
        FT_Outline_Get_CBox(&p->face->glyph->outline, &box);
        int64_t width = (((int64_t)box.xMax + 63) & ~63LL) - ((int64_t)box.xMin & ~63LL);
        int64_t height = (((int64_t)box.yMax + 63) & ~63LL) - ((int64_t)box.yMin & ~63LL);
        width /= 64; height /= 64;
        if (width < 0 || height < 0 || width > 512 || height > 512 || width * height > 65536) return -3;
    }
    err = FT_Render_Glyph(p->face->glyph, FT_RENDER_MODE_NORMAL);
    if (err) return err;
    FT_GlyphSlot slot = p->face->glyph;
    if (slot->bitmap.pixel_mode != FT_PIXEL_MODE_GRAY && slot->bitmap.width * slot->bitmap.rows != 0) return -2;
    if (slot->bitmap.width > 512 || slot->bitmap.rows > 512 || (uint64_t)slot->bitmap.width * slot->bitmap.rows > 65536) return -3;
    info[0] = slot->bitmap.width; info[1] = slot->bitmap.rows;
    info[2] = slot->bitmap_left; info[3] = slot->bitmap_top;
    info[4] = slot->bitmap.width * slot->bitmap.rows;
    return 0;
}
EXPORT int pocket_ft_copy(void *handle, unsigned char *out, uint32_t capacity) {
    struct pocket_face *p = handle;
    if (!p) return -1;
    FT_Bitmap *b = &p->face->glyph->bitmap;
    uint32_t length = b->width*b->rows;
    if (capacity < length) return -1;
    for (uint32_t y=0; y<b->rows; y++) {
        const unsigned char *src = b->buffer + (b->pitch >= 0 ? y : b->rows-1-y) * abs(b->pitch);
        memcpy(out + y*b->width, src, b->width);
    }
    return length;
}

#include <gccore.h>
#include <stdio.h>
#include <stdint.h>
#include "w06b_fixture.h"
#include "w06c_fixture.h"

extern uint8_t *pocket_wii_probe_alloc(size_t size, size_t alignment);
extern void pocket_wii_probe_free(uint8_t *ptr, size_t size, size_t alignment);
extern float pocket_wii_probe_floats(float a, float b);
extern uint32_t pocket_wii_probe_core_alloc(void);

typedef struct {
    const uint8_t *name;
    size_t name_length;
    size_t blob_length;
} W06aProbeEntry;

typedef struct {
    const uint8_t *target;
    size_t target_length;
    uint32_t host_abi;
    size_t pak_length;
    size_t entry_count;
    W06aProbeEntry entries[2];
} W06aProbeSummary;

extern uint32_t pocket_wii_probe_w06a(W06aProbeSummary *out);

typedef struct {
    uint8_t prop;
    uint32_t value;
} W06bProbeProp;

typedef struct {
    uint32_t codepoint;
    uint16_t gid;
    uint8_t advance;
    uint8_t xoff;
} W06bProbeGlyph;

typedef struct {
    size_t style_count;
    size_t variant_counts[3];
    W06bProbeProp variant_props[3][32];
    uint8_t atlas_slot;
    uint8_t atlas_flags;
    uint16_t atlas_glyph_count;
    uint32_t cell_w;
    uint32_t cell_h;
    uint32_t baseline;
    uint32_t line_height;
    uint32_t coverage_w;
    uint32_t coverage_h;
    uint8_t raster_density;
    W06bProbeGlyph glyphs[2];
    size_t coverage_len;
    uint8_t coverage[64];
    uint32_t diagnostics[6];
} W06bProbeSummary;

extern uint32_t pocket_wii_probe_w06b(
    const uint8_t *styles,
    size_t styles_len,
    const uint8_t *font,
    size_t font_len,
    W06bProbeSummary *out);

typedef struct {
    const uint8_t *pixels;
    size_t pixel_len;
    const uint8_t *palette;
    size_t palette_len;
    uint32_t width;
    uint32_t height;
    uint32_t psm;
    const uint32_t *draw_words;
    size_t draw_len;
    void *owner;
} W06cProbeSummary;

extern uint32_t pocket_wii_probe_w06c(const uint8_t *texture, size_t texture_len, W06cProbeSummary *out);
extern void pocket_wii_probe_w06c_free(void *owner);

static uint32_t read_le32(const uint8_t *bytes) {
    return (uint32_t)bytes[0] | (uint32_t)bytes[1] << 8 | (uint32_t)bytes[2] << 16 | (uint32_t)bytes[3] << 24;
}

int main(void) {
    SYS_STDIO_Report(true);
    puts("W03 probe started");

    uint8_t *ptr = pocket_wii_probe_alloc(64, 16);
    if (ptr == NULL) {
        puts("W03 FAIL: Rust allocation returned null");
        return 1;
    }
    if ((uintptr_t)ptr % 16 != 0) {
        puts("W03 FAIL: pointer is not 16-byte aligned");
        return 2;
    }
    for (size_t i = 0; i < 64; ++i) ptr[i] = (uint8_t)i;
    pocket_wii_probe_free(ptr, 64, 16);
    puts("W03 Rust allocation/free and alignment passed");

    volatile float result = pocket_wii_probe_floats(1.25f, -3.5f);
    if (result != -8.0f) {
        printf("W03 FAIL: float arguments/result mismatch: %f\n", result);
        return 3;
    }
    puts("W03 f32 argument ABI passed");
    if (pocket_wii_probe_core_alloc() != 1) {
        puts("W03 FAIL: pocketjs-core allocation/tick failed");
        return 4;
    }

    puts("W03 PASS: Rust allocation/free, 16-byte alignment, core, f32 ABI");
    W06aProbeSummary summary;
    if (pocket_wii_probe_w06a(&summary) != 1 || summary.entry_count != 2) {
        puts("W06A FAIL: Rust package/pak decode failed");
        return 5;
    }
    printf("W06A PASS target=%.*s abi=%u pak=%zu entries=%.*s:%zu,%.*s:%zu\n",
        (int)summary.target_length, (const char *)summary.target,
        summary.host_abi, summary.pak_length,
        (int)summary.entries[0].name_length, (const char *)summary.entries[0].name,
        summary.entries[0].blob_length,
        (int)summary.entries[1].name_length, (const char *)summary.entries[1].name,
        summary.entries[1].blob_length);

    W06bProbeSummary w06b;
    uint32_t w06b_result = pocket_wii_probe_w06b(w06b_styles, sizeof(w06b_styles), w06b_font, sizeof(w06b_font), &w06b);
    if (w06b_result != 1) {
        printf("W06B FAIL stage=%lu styles=%lu font=%lu", (unsigned long)w06b_result,
            (unsigned long)sizeof(w06b_styles), (unsigned long)sizeof(w06b_font));
        if (w06b_result == 12) {
            printf(" width=%08lx:%08lx bg=%08lx:%08lx opacity=%08lx:%08lx",
                (unsigned long)w06b.diagnostics[0], (unsigned long)w06b.diagnostics[1],
                (unsigned long)w06b.diagnostics[2], (unsigned long)w06b.diagnostics[3],
                (unsigned long)w06b.diagnostics[4], (unsigned long)w06b.diagnostics[5]);
        }
        putchar('\n');
        return 6;
    }
    printf("W06B PASS styles=%zu style=", w06b.style_count);
    for (size_t v = 0; v < 3; ++v) {
        printf("%s[", v == 0 ? "B" : v == 1 ? "/F" : "/A");
        for (size_t i = 0; i < w06b.variant_counts[v]; ++i) {
            printf("%s%u:%08lx", i == 0 ? "" : ",", w06b.variant_props[v][i].prop,
                (unsigned long)w06b.variant_props[v][i].value);
        }
        putchar(']');
    }
    printf(" atlas=%u,%u,%u,%u,%u,%u,%u,%u,%u,%u cmap=",
        w06b.atlas_slot, w06b.atlas_flags, w06b.atlas_glyph_count,
        w06b.cell_w, w06b.cell_h, w06b.baseline, w06b.line_height,
        w06b.raster_density, w06b.coverage_w, w06b.coverage_h);
    for (size_t i = 0; i < 2; ++i) {
        const W06bProbeGlyph *glyph = &w06b.glyphs[i];
        printf("%s%08lx:%u:%u:%u", i == 0 ? "" : ",",
            (unsigned long)glyph->codepoint, glyph->gid, glyph->advance, glyph->xoff);
    }
    printf(" coverage=");
    for (size_t i = 0; i < w06b.coverage_len; ++i) printf("%02x", w06b.coverage[i]);
    putchar('\n');

    W06cProbeSummary w06c = {0};
    uint32_t w06c_result = pocket_wii_probe_w06c(w06c_texture, sizeof(w06c_texture), &w06c);
    if (w06c_result != 1 || w06c.pixels == NULL || w06c.palette == NULL || w06c.draw_words == NULL
        || w06c.pixel_len != 8 || w06c.palette_len != 1024 || w06c.draw_len > 64 || w06c.owner == NULL) {
        printf("W06C FAIL stage=%u pixels=%zu palette=%zu draw=%zu\n", w06c_result,
            w06c.pixel_len, w06c.palette_len, w06c.draw_len);
        return 7;
    }
    printf("W06C PASS texture=%ux%u:%u pixels=", w06c.width, w06c.height, w06c.psm);
    for (size_t i = 0; i < w06c.pixel_len; ++i) printf("%02x", w06c.pixels[i]);
    printf(" colors=");
    for (size_t i = 0; i < w06c.pixel_len; ++i) {
        printf("%s%08x", i == 0 ? "" : ",", (unsigned)read_le32(w06c.palette + 4 * w06c.pixels[i]));
    }
    printf(" draw=");
    for (size_t i = 0; i < w06c.draw_len; ++i) {
        printf("%s%08x", i == 0 ? "" : ",", (unsigned)w06c.draw_words[i]);
    }
    putchar('\n');
    pocket_wii_probe_w06c_free(w06c.owner);
    return 0;
}

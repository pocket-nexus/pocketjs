#include "../../../devices/3ds/pocket-3ds-pica/src/driver.c"
#include <stdio.h>

void *pocket_host_alloc(size_t n, size_t a) {
  (void)a;
  return malloc(n);
}
void *pocket_host_realloc(void *p, size_t old, size_t a, size_t n) {
  (void)old;
  (void)a;
  return realloc(p, n);
}
void pocket_host_free(void *p, size_t n, size_t a) {
  (void)n;
  (void)a;
  free(p);
}
void pocket_host_panic(const char *s, size_t n) {
  fwrite(s, 1, n, stderr);
  abort();
}
void pocket_host_log(int32_t l, const char *s, size_t n) {
  (void)l;
  (void)s;
  (void)n;
}
void pocket_host_boot_stage(int32_t s) { (void)s; }
static uint8_t image[4] = {1, 2, 3, 255};
static uint8_t font_pixels[8] = {10, 20, 30, 40, 50, 60, 70, 80};
static uint64_t revision = 1;
static int32_t texture(const void *context, int32_t handle,
                       pocket_texture_view *out) {
  (void)context;
  if (handle != 42)
    return POCKET_STATUS_INVALID;
  *out = (pocket_texture_view){sizeof *out, image, sizeof image, 1, 1, 3,
                               NULL,        0,     revision,     0};
  return 0;
}
static int32_t texture_revision(const void *context, int32_t handle,
                                uint64_t *out) {
  (void)context;
  if (handle != 42)
    return POCKET_STATUS_INVALID;
  *out = revision;
  return 0;
}
static int32_t font(const void *context, uint8_t slot, pocket_font_view *out) {
  (void)context;
  if (slot != 0)
    return POCKET_STATUS_INVALID;
  *out = (pocket_font_view){
      sizeof *out, font_pixels, sizeof font_pixels, 2, 2, 1, 2};
  return 0;
}
static int32_t font_revision(const void *context, uint8_t slot, uint64_t *out) {
  (void)context;
  (void)slot;
  *out = revision;
  return 0;
}
static uint32_t xy(int x, int y) {
  return (uint16_t)x | ((uint32_t)(uint16_t)y << 16);
}
static uint32_t fw(float value) {
  uint32_t w;
  memcpy(&w, &value, 4);
  return w;
}
static pocket_render_resources resources(void) {
  pocket_render_resources r = {.struct_size = sizeof r,
                               .viewport_width = 400,
                               .viewport_height = 240,
                               .raster_revision = 1,
                               .texture = texture,
                               .font_atlas = font,
                               .texture_revision = texture_revision,
                               .font_revision = font_revision};
  return r;
}
static pocket_pica_renderer *create(size_t budget) {
  static uint32_t shader[4];
  pocket_pica_config config = {
      .shader = shader, .shader_size = sizeof shader, .texture_budget = budget};
  pocket_pica_renderer *r = pocket_pica_renderer_create(&config);
  assert(r);
  return r;
}
static uint64_t submit(pocket_pica_renderer *r, pocket_pica_display *d,
                       const uint32_t *words, size_t n, int expected) {
  pocket_target target = {.struct_size = sizeof target};
  pocket_rect region = {sizeof region, 0, 0, d->width, d->height};
  assert(acquire(d, &region, &target) == 0);
  pocket_draw_list list = {sizeof list, words, n, POCKET_DRAW_LIST_VERSION};
  pocket_render_resources res = resources();
  pocket_frame_input frame = {sizeof frame, &list, &res, &region, 1, &target};
  uint64_t id = 0;
  assert(render(r, &frame, &id) == expected);
  return id;
}
static void finish(pocket_pica_renderer *r, pocket_pica_display *d,
                   uint64_t id) {
  assert(render_wait(r, id) == 0);
  uint64_t token;
  assert(display_flush(d, &d->region, 1, &token) == 0);
  assert(display_wait(d, token) == 0);
  retire(r, id);
}
static void versioned_two_screen_submission(void) {
  C3D_RenderTarget target[2] = {
      {.frameBuf = {.colorBuf = framebuffer, .width = 240, .height = 400}},
      {.frameBuf = {.colorBuf = framebuffer, .width = 240, .height = 320}}};
  pocket_pica_renderer *r = create(1024 * 1024);
  pocket_pica_display *top =
      pocket_pica_display_create(r, 0, &target[0], NULL, 400, 240);
  pocket_pica_display *bottom =
      pocket_pica_display_create(r, 1, &target[1], NULL, 320, 240);
  assert(top && bottom);
  uint32_t words[] = {POCKET_DRAW_OP_TEX_QUAD,
                      42,
                      xy(3, 4),
                      xy(10, 12),
                      fw(0),
                      fw(0),
                      fw(1),
                      fw(1),
                      0xffffffff};
  uint64_t first = submit(r, top, words, 9, 0);
  Cache *old = r->cache;
  assert(old->refs == 1);
  unsigned old_begins = begins;
  image[0] = 4;
  image[1] = 5;
  image[2] = 6;
  revision++;
  uint64_t second = submit(r, bottom, words, 9, 0);
  Cache *new = r->cache;
  assert(old != new && old->refs == 1 && new->refs == 1 &&
         begins == old_begins);
  size_t offset = morton_offset(0, 7) * 4;
  assert(!memcmp((uint8_t *)old->texture.data + offset,
                 (uint8_t[]){255, 3, 2, 1}, 4));
  assert(!memcmp((uint8_t *)new->texture.data + offset,
                 (uint8_t[]){255, 6, 5, 4}, 4));
  words[2] = xy(90, 90);
  assert(r->pending->vertices[0].x == 3);
  finish(r, bottom, second);
  assert(old->refs == 1 && new->refs == 0);
  finish(r, top, first);
  assert(!old->refs && !new->refs);
  assert(swaps[0] == 1 && swaps[1] == 1 && transfers == 2);
  pocket_pica_renderer_destroy(r);
  assert(!tex_live && !linear_live && !native_open && !queued);
}
static void pressure_and_failure_recovery(void) {
  C3D_RenderTarget target[2] = {
      {.frameBuf = {.colorBuf = framebuffer, .width = 240, .height = 400}},
      {.frameBuf = {.colorBuf = framebuffer, .width = 240, .height = 320}}};
  pocket_pica_renderer *r = create(256);
  pocket_pica_display *top =
      pocket_pica_display_create(r, 0, &target[0], NULL, 400, 240);
  pocket_pica_display *bottom =
      pocket_pica_display_create(r, 1, &target[1], NULL, 320, 240);
  uint32_t words[] = {POCKET_DRAW_OP_TEX_QUAD,
                      42,
                      0,
                      xy(10, 10),
                      0,
                      0,
                      fw(1),
                      fw(1),
                      0xffffffff};
  uint64_t first = submit(r, top, words, 9, 0);
  Cache *old = r->cache;
  revision++;
  assert(submit(r, bottom, words, 9, POCKET_STATUS_FAILED) == 0);
  assert(r->cache == old && old->refs == 1 && linear_live == 1);
  finish(r, top, first);
  uint64_t next = submit(r, bottom, words, 9, 0);
  assert(r->cache->revision == revision);
  finish(r, bottom, next);
  fail_linear = true;
  submit(r, top, words, 9, POCKET_STATUS_FAILED);
  fail_linear = false;
  fail_buffer = true;
  submit(r, top, words, 9, POCKET_STATUS_FAILED);
  fail_buffer = false;
  unsigned before = begins;
  uint32_t invalid[] = {POCKET_DRAW_OP_RECT, 0, xy(1, 1), ~0u,
                        POCKET_DRAW_OP_TEX_QUAD};
  submit(r, top, invalid, 5, POCKET_STATUS_INVALID);
  assert(begins == before && !linear_live);
  first = submit(r, top, words, 9, 0);
  finish(r, top, first);
  pocket_pica_renderer_destroy(r);
  assert(!tex_live && !linear_live);
}
static void glyph_revision_clip_and_destroy_pending(void) {
  C3D_RenderTarget target = {
      .frameBuf = {.colorBuf = framebuffer, .width = 240, .height = 400}};
  pocket_pica_renderer *r = create(1024 * 1024);
  pocket_pica_display *top =
      pocket_pica_display_create(r, 0, &target, NULL, 400, 240);
  uint32_t words[] = {POCKET_DRAW_OP_SCISSOR,
                      xy(2, 3),
                      xy(10, 12),
                      POCKET_DRAW_OP_SCISSOR,
                      xy(5, 6),
                      xy(20, 20),
                      POCKET_DRAW_OP_GLYPH_RUN,
                      2u << 16,
                      0xffffffff,
                      xy(3, 4),
                      0,
                      xy(6, 4),
                      1,
                      POCKET_DRAW_OP_SCISSOR_POP,
                      POCKET_DRAW_OP_SCISSOR_POP};
  uint64_t first = submit(r, top, words, sizeof words / 4, 0);
  assert(r->cache->font);
  assert(r->pending->vertex_count == 12 && r->pending->command_count == 1);
  assert(r->pending->commands[0].clip.x0 == 5 &&
         r->pending->commands[0].clip.x1 == 25);
  assert(last_scissor[0] == 214 && last_scissor[1] == 375 &&
         last_scissor[2] == 234 && last_scissor[3] == 395);
  Cache *old = r->cache;
  finish(r, top, first);
  font_pixels[0] = 99;
  revision++;
  submit(r, top, words, sizeof words / 4, 0);
  assert(r->cache != old && r->cache->revision == revision);
  pocket_pica_renderer_destroy(r);
  assert(!tex_live && !linear_live && !native_open && !queued);
}
static void prefixes_targets_and_stereo(void) {
  C3D_RenderTarget targets[3] = {
      {.frameBuf = {.colorBuf = framebuffer, .width = 240, .height = 400}},
      {.frameBuf = {.colorBuf = framebuffer, .width = 240, .height = 400}},
      {.frameBuf = {.colorBuf = framebuffer, .width = 240, .height = 400}}};
  pocket_pica_renderer *r = create(1024 * 1024);
  pocket_pica_renderer *foreign = create(1024 * 1024);
  assert(!pocket_pica_display_create(r, 0, &targets[0], &targets[0], 400, 240));
  targets[1].linked = true;
  assert(!pocket_pica_display_create(r, 0, &targets[0], &targets[1], 400, 240));
  targets[1].linked = false;
  targets[1].frameBuf.colorBuf = NULL;
  assert(!pocket_pica_display_create(r, 0, &targets[0], &targets[1], 400, 240));
  targets[1].frameBuf.colorBuf = framebuffer;
  pocket_pica_display *top =
      pocket_pica_display_create(r, 0, &targets[0], &targets[1], 400, 240);
  pocket_pica_display *other =
      pocket_pica_display_create(foreign, 0, &targets[2], NULL, 400, 240);
  assert(top && other && top->id != other->id);
  uint32_t words[] = {
      POCKET_DRAW_OP_TEX_QUAD, 42, 0, xy(10, 10), 0, 0, fw(1), fw(1), ~0u};
  pocket_rect region = {sizeof region, 0, 0, 400, 240};
  pocket_target target = {.struct_size = sizeof target};
  assert(!acquire(top, &region, &target));
  pocket_draw_list list = {sizeof list, words, 9, POCKET_DRAW_LIST_VERSION};
  pocket_render_resources res = resources();
  pocket_frame_input frame = {sizeof frame, &list, &res, &region, 1, &target};
  uint64_t id = 0;
  assert(render(foreign, &frame, &id) == POCKET_STATUS_INVALID);
  assert(render(r, &(pocket_frame_input){.struct_size = sizeof(size_t)}, &id) ==
         POCKET_STATUS_INVALID);
  /* A callback has nonzero bytes in a prefix that ends before the field is
   * complete. Only complete fields are visible to the consumer. */
  res.struct_size = offsetof(pocket_render_resources, texture_revision) + 1;
  memset((char *)&res + offsetof(pocket_render_resources, texture_revision),
         0xff, sizeof(res.texture_revision));
  unsigned before = transfers;
  assert(!render(r, &frame, &id));
  finish(r, top, id);
  assert(transfers == before + 1); /* 2D right framebuffer aliases the left. */
  stereo_enabled = true;
  before = transfers;
  id = submit(r, top, words, 9, 0);
  finish(r, top, id);
  assert(transfers == before + 2);
  stereo_enabled = false;
  pocket_pica_renderer_destroy(foreign);
  pocket_pica_renderer_destroy(r);
  assert(!tex_live && !linear_live && !queued);
}
static C3D_Tex external_texture;
static unsigned leases, releases;
static int32_t native_resolve(void *context, int32_t handle,
                              pocket_pica_native_texture *out) {
  (void)context;
  if (handle == 77) {
    leases++;
    *out = (pocket_pica_native_texture){&external_texture, 1, 1,
                                        &external_texture};
  }
  return 0;
}
static void native_release(void *context, void *lease) {
  (void)context;
  assert(lease == &external_texture && !queued);
  releases++;
}
static void native_leases_survive_wait_until_retire(void) {
  C3D_RenderTarget target = {
      .frameBuf = {.colorBuf = framebuffer, .width = 240, .height = 400}};
  pocket_pica_renderer *r = create(1024 * 1024);
  r->config.resolve = native_resolve;
  r->config.release = native_release;
  pocket_pica_display *top =
      pocket_pica_display_create(r, 0, &target, NULL, 400, 240);
  uint32_t words[] = {
      POCKET_DRAW_OP_TEX_QUAD, 77, 0, xy(10, 10), 0, 0, fw(1), fw(1), ~0u,
      POCKET_DRAW_OP_TEX_QUAD, 42, 0, xy(10, 10), 0, 0, fw(1), fw(1), ~0u};
  fail_tex = true;
  submit(r, top, words, 18, POCKET_STATUS_FAILED);
  fail_tex = false;
  assert(leases == 1 && releases == 1 && !linear_live);
  uint64_t id = submit(r, top, words, 9, 0);
  assert(leases == 2 && releases == 1);
  assert(!render_wait(r, id) && releases == 1);
  retire(r, id);
  assert(releases == 2);
  id = submit(r, top, words, 9, 0);
  (void)id;
  pocket_pica_renderer_destroy(r);
  assert(leases == 3 && releases == 3 && !tex_live && !linear_live);
}
int main(void) {
  versioned_two_screen_submission();
  pressure_and_failure_recovery();
  glyph_revision_clip_and_destroy_pending();
  prefixes_targets_and_stereo();
  native_leases_survive_wait_until_retire();
  puts("PICA driver lifecycle, versioning, guarded fonts and real DrawList "
       "visitor passed");
  return 0;
}

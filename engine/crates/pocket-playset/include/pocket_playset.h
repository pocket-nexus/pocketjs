/* pocket-playset C ABI (engine/crates/pocket-playset/src/cabi.rs).
 *
 * Descriptor layouts and view strides are in contracts/spec/playset.ts. A
 * host creates one playset per guest, hands the guest Float32Array views of
 * pps_view(), calls pps_step from the guest's frame and pps_prepare from its
 * renderer, and destroys the playset after the guest's realm is gone. */
#ifndef POCKET_PLAYSET_H
#define POCKET_PLAYSET_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct pps pps;

/* 20 bytes: position, normal x/y/z in [-127, 127] with the bone slot in the
 * fourth byte, sRGB colour with emissive (or opacity) in the fourth byte. */
typedef struct {
  float pos[3];
  int8_t nb[4];
  uint8_t rgba[4];
} pps_vertex;

enum {
  PPS_SOURCE_MODEL = 0,
  PPS_SOURCE_BATCH = 1,
  PPS_SOURCE_GROUND = 2,
  PPS_SOURCE_DYNAMIC = 3,
};

enum {
  PPS_DRAW_CULL = 1,
  /* vertex alpha is opacity; no lighting */
  PPS_DRAW_VERTEX_ALPHA = 2,
  PPS_DRAW_DEPTH_WRITE = 4,
};

enum { PPS_BLEND_OPAQUE = 0, PPS_BLEND_ALPHA = 1, PPS_BLEND_ADD = 2 };

typedef struct {
  uint8_t source, blend, flags, pad;
  uint16_t id;
  /* matrices to upload from bone_first; each is 16 floats: rows 0..2 of a
   * 3x4 world matrix, then an rgba tint */
  uint16_t bones;
  uint32_t bone_first;
  uint32_t index_first;
  uint32_t index_count;
  float opacity;
} pps_draw;

typedef struct {
  /* world to view, 3x4 rows; the view looks down -Z */
  float view[12];
  float fov_y, near_plane, far_plane, aspect;
  float sky_top[4], sky_horizon[4], sky_bottom[4];
  /* start, 1 / (end - start), max, 0 */
  float fog[4];
  float fog_color[4];
  /* toward the sun; the colours below are linear */
  float sun_dir[4], sun_color[4], hemi_sky[4], hemi_ground[4];
  float eye[4];
  const pps_draw *draws;
  uint32_t draw_count;
  const float *bones;
  uint32_t bone_count;
  const pps_vertex *dyn_verts;
  uint32_t dyn_vertex_count;
  const uint16_t *dyn_idx;
  uint32_t dyn_index_count;
  uint32_t tris;
  uint32_t culled;
} pps_frame;

pps *pps_create(uint32_t capacity, uint32_t particles);
void pps_destroy(pps *p);
float *pps_view(pps *p, uint32_t which, uint32_t *length);

int32_t pps_model(pps *p, const float *desc, uint32_t n);
/* xf: x, y, z, yaw, pitch, roll, scale; flags bit 31 = xf is 12 floats of 3x4 */
int32_t pps_node(pps *p, int32_t model, const float *xf, uint32_t flags);
void pps_node_set(pps *p, int32_t node, const float *xf, uint32_t flags);
void pps_node_remove(pps *p, int32_t node);
void pps_env(pps *p, uint32_t kind, const float *params, uint32_t n);
void pps_terrain(pps *p, uint32_t w, uint32_t h, float cell, const float *origin,
                 const float *heights, uint32_t hn, const float *bands, uint32_t bn);
int32_t pps_collider(pps *p, uint32_t shape, const float *params, uint32_t n);
void pps_colliders_clear(pps *p);
void pps_lod(pps *p, uint32_t radial, uint32_t rings, uint32_t tubular);

int32_t pps_arch(pps *p, const float *desc, uint32_t n);
void pps_arch_set(pps *p, int32_t id, const float *desc, uint32_t n);
int32_t pps_rule(pps *p, uint32_t a, uint32_t b, uint32_t flags, float value);
void pps_rules_clear(pps *p);
int32_t pps_path(pps *p, const float *pts, uint32_t n);
int32_t pps_emitter(pps *p, const float *desc, uint32_t n);

int32_t pps_spawn(pps *p, int32_t arch, float x, float y, float z, float yaw);
void pps_kill(pps *p, int32_t slot, int32_t mode);
/* every slot and particle goes; content, archetypes and rules stay */
void pps_clear(pps *p);
void pps_revive(pps *p, int32_t slot, float hp);
void pps_attach(pps *p, int32_t slot, int32_t parent, float x, float y, float z,
                float yaw, int32_t follow);
void pps_layer(pps *p, int32_t slot, uint32_t layer, uint32_t mask, int32_t team);
void pps_emit(pps *p, int32_t emitter, float x, float y, float z, float count);
void pps_fire(pps *p, int32_t slot, int32_t weapon);
int32_t pps_step(pps *p, float dt);
void pps_camera(pps *p, const float *desc, uint32_t n);
float pps_query(pps *p, uint32_t kind, float a, float b, float c, float d);
void pps_seed(pps *p, uint32_t seed);

const pps_frame *pps_prepare(pps *p, float aspect);
uint32_t pps_model_count(pps *p);
int32_t pps_model_data(pps *p, uint32_t id, const uint8_t **verts, uint32_t *nverts,
                       const uint16_t **idx, uint32_t *nidx);
uint32_t pps_batch_count(pps *p, uint32_t source);
int32_t pps_batch_data(pps *p, uint32_t source, uint32_t id, const uint8_t **verts,
                       uint32_t *nverts, const uint16_t **idx, uint32_t *nidx,
                       uint32_t *revision);
void pps_note_timing(pps *p, float step_us, float prepare_us, float render_us);

#ifdef __cplusplus
}
#endif
#endif

/*
 * The agent stage: the mascot's room on the top screen (stage.h).
 *
 * Everything is built once at init from boxes, cylinders and quads into one
 * linear-memory vertex buffer, grouped so a frame draws it in five calls per
 * eye: the lit geometry, the outlines of the furniture and the mascot, the
 * unlit pieces (sky, poster art, lamp), the monitor's screen (textured) and
 * the soft shadows. Each vertex carries a bone index (stage.v.pica): bone 0
 * is the room, the clock hands and the plant have bones of their own, and the
 * mascot is ten bones (body, eyes, arms, legs) plus its shadow.
 *
 * The mascot is Clawd, Claude's pixel creature, as a box creature: an orange
 * block with two upright black eyes, arm stubs at its sides and four short
 * legs. It sits on a cushion facing the viewer; its monitor stands on a side
 * desk to its right. The animation is procedural: a pose target from the
 * mode and a small idle scheduler, eased toward every frame, with breathing,
 * blinking, typing and hops (a spring on the body's squash) added on top.
 *
 * The monitor shows one of three textures: the touch screen (copied from its
 * render target with a raw texture copy each second frame), the agent's own
 * screen (RGB565 frames from the companion, tiled by the transfer engine) or
 * the screensaver (the PocketJS mark and its name on plum, stage_saver.h,
 * drifting about the screen and turning back at its edges).
 *
 * Over both eyes, at the screen's own pixels, a pill in the bottom-right
 * corner says that L+R asks Claude (stage_hint.h, baked by
 * tools/3ds-stage-art.ts). It shows while the mascot is idle.
 */

#include "stage.h"

#include <3ds.h>
#include <citro3d.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "link.h"
#include "stage_hint.h"
#include "stage_saver.h"
#include "stage_shbin.h"

/* contracts/spec/agent.ts */
#define MODE_IDLE 0
#define MODE_ATTEND 1
#define MODE_LISTEN 2
#define MODE_THINK 3
#define MODE_ACT 4
#define MODE_SPEAK 5
#define MODE_HAPPY 6
#define SCREEN_IDLE 0
#define SCREEN_MIRROR 1
#define SCREEN_OWN 2

#define PI 3.14159265f
#define MAX_VERTICES 9000u

/* Bones (stage.v.pica `bones`, three rows each). */
#define BONE_ROOM 0
#define BONE_HOUR 1
#define BONE_MINUTE 2
#define BONE_PLANT 3
#define BONE_BODY 5
#define BONE_EYE_L 6
#define BONE_EYE_R 7
#define BONE_ARM_L 8
#define BONE_ARM_R 9
#define BONE_LEG0 10
#define BONE_SHADOW 14
#define BONE_COUNT 16

typedef struct {
  float x, y, z;
  int8_t nx, ny, nz, bone;
  uint8_t r, g, b, a;
  float u, v;
  /* The outline's direction (stage.v.pica). */
  int8_t sx, sy, sz, pad;
} StageVertex;

typedef struct {
  float m[3][4];
} Aff;

typedef struct {
  uint32_t first;
  uint32_t count;
} Range;

/* What the mascot's pose eases toward, and where it is. */
typedef struct {
  float yaw, pitch, roll, hop;
  float eye_open, eye_x, eye_y, eye_size;
  /* Arms: raised about the body's side, then turned forward (reach). */
  float arm_raise[2], arm_reach[2];
  float leg[4];
} Pose;

static DVLB_s *shader_blob;
static shaderProgram_s program;
static int u_proj, u_bones, u_light, u_tone, u_outline, u_outcol, u_uvs, u_uvt;
static C3D_AttrInfo attributes;
static C3D_BufInfo buffers;

static StageVertex *vertices;
static uint32_t vertex_count;
static Range lit, outlined, unlit, screen, shadows, hint;

static C3D_Tex mirror_tex;
static C3D_Tex own_tex;
static C3D_Tex saver_tex;
static C3D_Tex hint_tex;
/* The hint's opacity, 0 to 1, eased toward 1 while idle. */
static float hint_alpha;
static uint16_t *staging; /* 512x256 RGB565, linear memory */
static bool mirror_ready;
static bool own_ready;
static bool initialized;

static int mode = MODE_IDLE;
static int screen_source = SCREEN_IDLE;
static float level;
static uint32_t frame;
static uint32_t last_activity;
static uint32_t last_us;

static Pose pose;
static Pose target;
/* The body's squash spring and the hop's height and speed. */
static float squash = 1.0f, squash_v;
static float hop_y, hop_v;
static uint32_t rng = 0x2545f491u;
/* The idle scheduler: what the mascot does now and until when. */
static int act;
static uint32_t act_until;
static uint32_t blink_at = 90, blink_end;
static bool watching_user;
static float typing_phase;
/* The screensaver's centre on the screen (0..1 across and down) and its
 * velocity a frame. */
static float saver_x = 0.5f, saver_y = 0.45f;
static float saver_vx = 0.0012f, saver_vy = 0.0009f;
static uint32_t mode_since;

enum { ACT_REST, ACT_LOOK, ACT_WATCH, ACT_KICK, ACT_STRETCH, ACT_HOP, ACT_SLEEP };

// ---------------------------------------------------------------------------
// maths
// ---------------------------------------------------------------------------

static Aff aff_identity(void) {
  Aff a = {{{1, 0, 0, 0}, {0, 1, 0, 0}, {0, 0, 1, 0}}};
  return a;
}

static Aff aff_mul(const Aff *a, const Aff *b) {
  Aff out;
  for (int r = 0; r < 3; r += 1) {
    for (int c = 0; c < 4; c += 1) {
      float value = a->m[r][0] * b->m[0][c] + a->m[r][1] * b->m[1][c] + a->m[r][2] * b->m[2][c];
      if (c == 3) value += a->m[r][3];
      out.m[r][c] = value;
    }
  }
  return out;
}

static Aff aff_translate(float x, float y, float z) {
  Aff a = aff_identity();
  a.m[0][3] = x;
  a.m[1][3] = y;
  a.m[2][3] = z;
  return a;
}

static Aff aff_scale(float x, float y, float z) {
  Aff a = aff_identity();
  a.m[0][0] = x;
  a.m[1][1] = y;
  a.m[2][2] = z;
  return a;
}

static Aff aff_rot_x(float angle) {
  float c = cosf(angle), s = sinf(angle);
  Aff a = {{{1, 0, 0, 0}, {0, c, -s, 0}, {0, s, c, 0}}};
  return a;
}

static Aff aff_rot_y(float angle) {
  float c = cosf(angle), s = sinf(angle);
  Aff a = {{{c, 0, s, 0}, {0, 1, 0, 0}, {-s, 0, c, 0}}};
  return a;
}

static Aff aff_rot_z(float angle) {
  float c = cosf(angle), s = sinf(angle);
  Aff a = {{{c, -s, 0, 0}, {s, c, 0, 0}, {0, 0, 1, 0}}};
  return a;
}

static Aff aff_then(Aff a, Aff b) {
  return aff_mul(&a, &b);
}

static void aff_point(const Aff *a, const float in[3], float out[3]) {
  for (int r = 0; r < 3; r += 1) {
    out[r] = a->m[r][0] * in[0] + a->m[r][1] * in[1] + a->m[r][2] * in[2] + a->m[r][3];
  }
}

static void aff_dir(const Aff *a, const float in[3], float out[3]) {
  for (int r = 0; r < 3; r += 1) {
    out[r] = a->m[r][0] * in[0] + a->m[r][1] * in[1] + a->m[r][2] * in[2];
  }
  float length = sqrtf(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]);
  if (length > 0.0001f) {
    out[0] /= length;
    out[1] /= length;
    out[2] /= length;
  }
}

static float clampf(float value, float low, float high) {
  return value < low ? low : value > high ? high : value;
}

static float ease(float current, float goal, float rate) {
  return current + (goal - current) * rate;
}

static uint32_t random_next(void) {
  rng ^= rng << 13;
  rng ^= rng >> 17;
  rng ^= rng << 5;
  return rng;
}

/* A float in [low, high). */
static float random_range(float low, float high) {
  return low + (high - low) * (float)(random_next() & 0xffff) / 65536.0f;
}

// ---------------------------------------------------------------------------
// mesh building
// ---------------------------------------------------------------------------

typedef struct {
  uint8_t r, g, b, a;
} Color;

#define RGB(hex) ((Color){(uint8_t)((hex) >> 16), (uint8_t)((hex) >> 8), (uint8_t)(hex), 255})

static Aff build_xf;
static int8_t build_bone;

static int8_t normal_byte(float value) {
  return (int8_t)lrintf(clampf(value, -1.0f, 1.0f) * 127.0f);
}

static void put_smooth(const float p[3], const float n[3], const float smooth[3], Color color, float u, float v) {
  if (vertex_count >= MAX_VERTICES) return;
  float wp[3], wn[3], ws[3];
  aff_point(&build_xf, p, wp);
  aff_dir(&build_xf, n, wn);
  aff_dir(&build_xf, smooth, ws);
  StageVertex *out = &vertices[vertex_count++];
  out->x = wp[0];
  out->y = wp[1];
  out->z = wp[2];
  out->nx = normal_byte(wn[0]);
  out->ny = normal_byte(wn[1]);
  out->nz = normal_byte(wn[2]);
  out->bone = build_bone;
  out->r = color.r;
  out->g = color.g;
  out->b = color.b;
  out->a = color.a;
  out->u = u;
  out->v = v;
  out->sx = normal_byte(ws[0]);
  out->sy = normal_byte(ws[1]);
  out->sz = normal_byte(ws[2]);
  out->pad = 0;
}

static void put(const float p[3], const float n[3], Color color, float u, float v) {
  put_smooth(p, n, n, color, u, v);
}

/* The outline direction of a point on a shape around `centre`: the sign of
 * each axis, so a box's corners all push straight out of the corner. */
static void corner_direction(const float p[3], const float centre[3], float out[3]) {
  for (int axis = 0; axis < 3; axis += 1) {
    float d = p[axis] - centre[axis];
    out[axis] = d > 0.0001f ? 1.0f : d < -0.0001f ? -1.0f : 0.0f;
  }
}

/* A quad whose outline pushes away from `centre`. */
static void quad_around(const float p[4][3], const float n[3], Color color, const float centre[3]) {
  static const int order[6] = {0, 1, 2, 0, 2, 3};
  for (int i = 0; i < 6; i += 1) {
    float smooth[3];
    corner_direction(p[order[i]], centre, smooth);
    put_smooth(p[order[i]], n, smooth, color, 0.0f, 0.0f);
  }
}

/* A quad p0 p1 p2 p3 counter-clockwise seen from its front. */
static void quad_uv(const float p[4][3], const float n[3], Color color, const float uv[4][2]) {
  static const int order[6] = {0, 1, 2, 0, 2, 3};
  for (int i = 0; i < 6; i += 1) {
    int k = order[i];
    put(p[k], n, color, uv ? uv[k][0] : 0.0f, uv ? uv[k][1] : 0.0f);
  }
}

static void quad(const float p[4][3], const float n[3], Color color) {
  quad_uv(p, n, color, NULL);
}

/* An axis-aligned box in the build transform, centred at (cx, cy, cz). */
static void box2(float cx, float cy, float cz, float sx, float sy, float sz, Color side, Color top) {
  float x0 = cx - sx / 2, x1 = cx + sx / 2;
  float y0 = cy - sy / 2, y1 = cy + sy / 2;
  float z0 = cz - sz / 2, z1 = cz + sz / 2;
  const float front[4][3] = {{x0, y0, z1}, {x1, y0, z1}, {x1, y1, z1}, {x0, y1, z1}};
  const float back[4][3] = {{x1, y0, z0}, {x0, y0, z0}, {x0, y1, z0}, {x1, y1, z0}};
  const float left[4][3] = {{x0, y0, z0}, {x0, y0, z1}, {x0, y1, z1}, {x0, y1, z0}};
  const float right[4][3] = {{x1, y0, z1}, {x1, y0, z0}, {x1, y1, z0}, {x1, y1, z1}};
  const float up[4][3] = {{x0, y1, z1}, {x1, y1, z1}, {x1, y1, z0}, {x0, y1, z0}};
  const float down[4][3] = {{x0, y0, z0}, {x1, y0, z0}, {x1, y0, z1}, {x0, y0, z1}};
  const float centre[3] = {cx, cy, cz};
  quad_around(front, (const float[3]){0, 0, 1}, side, centre);
  quad_around(back, (const float[3]){0, 0, -1}, side, centre);
  quad_around(left, (const float[3]){-1, 0, 0}, side, centre);
  quad_around(right, (const float[3]){1, 0, 0}, side, centre);
  quad_around(up, (const float[3]){0, 1, 0}, top, centre);
  quad_around(down, (const float[3]){0, -1, 0}, side, centre);
}

static void box(float cx, float cy, float cz, float sx, float sy, float sz, Color color) {
  box2(cx, cy, cz, sx, sy, sz, color, color);
}

/* An upright cylinder (a prism of `segments` sides) standing on y = cy. */
static void cylinder(float cx, float cy, float cz, float radius_bottom, float radius_top, float height,
                     int segments, Color side, Color top) {
  for (int i = 0; i < segments; i += 1) {
    float a0 = 2 * PI * (float)i / (float)segments;
    float a1 = 2 * PI * (float)(i + 1) / (float)segments;
    float am = (a0 + a1) / 2;
    float c0 = cosf(a0), s0 = sinf(a0), c1 = cosf(a1), s1 = sinf(a1);
    const float wall[4][3] = {
      {cx + radius_bottom * s0, cy, cz + radius_bottom * c0},
      {cx + radius_bottom * s1, cy, cz + radius_bottom * c1},
      {cx + radius_top * s1, cy + height, cz + radius_top * c1},
      {cx + radius_top * s0, cy + height, cz + radius_top * c0},
    };
    /* Outlines push out radially, and up or down at the rims. */
    static const int order[6] = {0, 1, 2, 0, 2, 3};
    for (int k = 0; k < 6; k += 1) {
      int corner = order[k];
      float a = (corner == 0 || corner == 3) ? a0 : a1;
      float rise = (corner >= 2) ? 0.8f : -0.8f;
      const float smooth[3] = {sinf(a), rise, cosf(a)};
      put_smooth(wall[corner], (const float[3]){sinf(am), 0, cosf(am)}, smooth, side, 0, 0);
    }
    const float centre[3] = {cx, cy + height, cz};
    const float up_rim0[3] = {sinf(a0), 0.8f, cosf(a0)};
    const float up_rim1[3] = {sinf(a1), 0.8f, cosf(a1)};
    put(centre, (const float[3]){0, 1, 0}, top, 0, 0);
    put_smooth(wall[3], (const float[3]){0, 1, 0}, up_rim0, top, 0, 0);
    put_smooth(wall[2], (const float[3]){0, 1, 0}, up_rim1, top, 0, 0);
  }
}

/* A flat disc facing +z at depth cz (for the clock), or facing +y when `up`. */
static void disc(float cx, float cy, float cz, float radius, int segments, Color color, bool up) {
  const float n[3] = {0, up ? 1.0f : 0.0f, up ? 0.0f : 1.0f};
  for (int i = 0; i < segments; i += 1) {
    float a0 = 2 * PI * (float)i / (float)segments;
    float a1 = 2 * PI * (float)(i + 1) / (float)segments;
    float p0[3], p1[3];
    if (up) {
      p0[0] = cx + radius * sinf(a0); p0[1] = cy; p0[2] = cz + radius * cosf(a0);
      p1[0] = cx + radius * sinf(a1); p1[1] = cy; p1[2] = cz + radius * cosf(a1);
    } else {
      p0[0] = cx + radius * cosf(a0); p0[1] = cy + radius * sinf(a0); p0[2] = cz;
      p1[0] = cx + radius * cosf(a1); p1[1] = cy + radius * sinf(a1); p1[2] = cz;
    }
    const float centre[3] = {cx, cy, cz};
    put(centre, n, color, 0, 0);
    put(p0, n, color, 0, 0);
    put(p1, n, color, 0, 0);
  }
}

/* A ring on the floor between two radii. */
static void ring_up(float cx, float cy, float cz, float inner, float outer, int segments, Color color) {
  for (int i = 0; i < segments; i += 1) {
    float a0 = 2 * PI * (float)i / (float)segments;
    float a1 = 2 * PI * (float)(i + 1) / (float)segments;
    const float p[4][3] = {
      {cx + inner * sinf(a0), cy, cz + inner * cosf(a0)},
      {cx + outer * sinf(a0), cy, cz + outer * cosf(a0)},
      {cx + outer * sinf(a1), cy, cz + outer * cosf(a1)},
      {cx + inner * sinf(a1), cy, cz + inner * cosf(a1)},
    };
    quad(p, (const float[3]){0, 1, 0}, color);
  }
}

/* A wall-facing rectangle at depth z: x0..x1, y0..y1, facing +z. */
static void panel(float x0, float y0, float x1, float y1, float z, Color color) {
  const float p[4][3] = {{x0, y0, z}, {x1, y0, z}, {x1, y1, z}, {x0, y1, z}};
  quad(p, (const float[3]){0, 0, 1}, color);
}

/* Claude's spark: `rays` thin wedges around a centre, facing +z. */
static void spark(float cx, float cy, float z, float radius, Color color) {
  const int rays = 12;
  for (int i = 0; i < rays; i += 1) {
    float angle = 2 * PI * (float)i / (float)rays + 0.13f;
    float length = radius * ((i % 3 == 0) ? 1.0f : (i % 3 == 1) ? 0.82f : 0.9f);
    float width = radius * 0.13f;
    float dx = cosf(angle), dy = sinf(angle);
    float px = -dy, py = dx;
    const float p[4][3] = {
      {cx + px * width * 0.5f, cy + py * width * 0.5f, z},
      {cx - px * width * 0.5f, cy - py * width * 0.5f, z},
      {cx + dx * length - px * width * 0.25f, cy + dy * length - py * width * 0.25f, z},
      {cx + dx * length + px * width * 0.25f, cy + dy * length + py * width * 0.25f, z},
    };
    quad(p, (const float[3]){0, 0, 1}, color);
  }
}

static Range begin_group(void) {
  Range range = {vertex_count, 0};
  return range;
}

static void end_group(Range *range) {
  range->count = vertex_count - range->first;
}

// ---------------------------------------------------------------------------
// the room
// ---------------------------------------------------------------------------

/* Room bounds (y up, the viewer looks toward -z). */
#define ROOM_X0 -3.4f
#define ROOM_X1 3.4f
#define ROOM_Z0 -2.2f
#define ROOM_Z1 2.0f
#define ROOM_H 3.4f

/* The mascot's cushion, and its seat on it. */
#define SEAT_X -0.55f
#define SEAT_Z -0.45f
#define SEAT_Y 0.2f
/* The mascot's legs: it stands on them, low. */
#define LEG_H 0.2f
/* Legs hang straight; a kick swings them about the hip. */
#define LEG_REST 0.0f

/* The side desk and the monitor on it. */
#define DESK_X 1.65f
#define DESK_Z -0.75f
#define DESK_W 1.5f
#define DESK_D 1.0f
#define DESK_H 0.8f
#define MONITOR_YAW -0.42f
#define SCREEN_W 1.2f
#define SCREEN_H 0.9f
#define SCREEN_Y (DESK_H + 0.14f + 0.5f)

/* The screensaver's texture as fractions of the screen's width and height
 * (its aspect kept), and the half extents of its lockup in screen fractions. */
#define SAVER_SPAN_W 0.95f
#define SAVER_SPAN_H (SAVER_SPAN_W * SCREEN_W * STAGE_SAVER_H / (SCREEN_H * STAGE_SAVER_W))
#define SAVER_HALF_W (STAGE_SAVER_HALF_X * SAVER_SPAN_W)
#define SAVER_HALF_H (STAGE_SAVER_HALF_Y * SAVER_SPAN_H)

/* The wall clock. */
#define CLOCK_X 1.65f
#define CLOCK_Y 2.3f
#define CLOCK_R 0.27f

#define PLANT_X -2.55f
#define PLANT_Z -1.4f

static void build_room_plain(void) {
  build_xf = aff_identity();
  build_bone = BONE_ROOM;
  /* Floor planks, running left to right. */
  const float plank = 0.42f;
  int index = 0;
  for (float z = ROOM_Z0; z < ROOM_Z1 - 0.001f; z += plank, index += 1) {
    float z1 = fminf(z + plank, ROOM_Z1);
    Color color = (index % 2) ? RGB(0xc48a57) : RGB(0xb87c4b);
    const float p[4][3] = {{ROOM_X0, 0, z1}, {ROOM_X1, 0, z1}, {ROOM_X1, 0, z}, {ROOM_X0, 0, z}};
    quad(p, (const float[3]){0, 1, 0}, color);
    /* A seam: a darker sliver at the plank's far edge, a hair above. */
    const float s[4][3] = {{ROOM_X0, 0.002f, z + 0.025f}, {ROOM_X1, 0.002f, z + 0.025f}, {ROOM_X1, 0.002f, z}, {ROOM_X0, 0.002f, z}};
    quad(s, (const float[3]){0, 1, 0}, RGB(0x9c6538));
  }
  /* Back wall: plaster above, panelling below, a baseboard. */
  panel(ROOM_X0, 1.05f, ROOM_X1, ROOM_H, ROOM_Z0, RGB(0xf1dfc6));
  panel(ROOM_X0, 0.12f, ROOM_X1, 1.0f, ROOM_Z0, RGB(0xdcae84));
  box(0, 1.025f, ROOM_Z0 + 0.03f, ROOM_X1 - ROOM_X0, 0.06f, 0.06f, RGB(0xc78a5d));
  box(0, 0.06f, ROOM_Z0 + 0.03f, ROOM_X1 - ROOM_X0, 0.12f, 0.06f, RGB(0xa86d45));
  /* Side walls. */
  {
    const float lw[4][3] = {{ROOM_X0, 0, ROOM_Z0}, {ROOM_X0, 0, ROOM_Z1}, {ROOM_X0, ROOM_H, ROOM_Z1}, {ROOM_X0, ROOM_H, ROOM_Z0}};
    quad(lw, (const float[3]){1, 0, 0}, RGB(0xead3b4));
    const float rw[4][3] = {{ROOM_X1, 0, ROOM_Z1}, {ROOM_X1, 0, ROOM_Z0}, {ROOM_X1, ROOM_H, ROOM_Z0}, {ROOM_X1, ROOM_H, ROOM_Z1}};
    quad(rw, (const float[3]){-1, 0, 0}, RGB(0xead3b4));
  }
  /* The window frame and sill (the sky is unlit, built later). */
  {
    const float x0 = -2.55f, x1 = -1.2f, y0 = 1.3f, y1 = 2.42f, z = ROOM_Z0 + 0.02f;
    Color frame_color = RGB(0xfdf8f0);
    box((x0 + x1) / 2, y1 + 0.04f, z, x1 - x0 + 0.16f, 0.08f, 0.06f, frame_color);
    box((x0 + x1) / 2, y0 - 0.04f, z, x1 - x0 + 0.16f, 0.08f, 0.06f, frame_color);
    box(x0 - 0.04f, (y0 + y1) / 2, z, 0.08f, y1 - y0, 0.06f, frame_color);
    box(x1 + 0.04f, (y0 + y1) / 2, z, 0.08f, y1 - y0, 0.06f, frame_color);
    box((x0 + x1) / 2, (y0 + y1) / 2, z + 0.01f, 0.05f, y1 - y0, 0.04f, frame_color);
    box((x0 + x1) / 2, (y0 + y1) / 2, z + 0.01f, x1 - x0, 0.05f, 0.04f, frame_color);
    box((x0 + x1) / 2, y0 - 0.1f, z + 0.1f, x1 - x0 + 0.3f, 0.05f, 0.22f, RGB(0xf6efe4));
  }
  /* The poster's frame and paper (its spark is unlit). */
  box(-0.1f, 1.95f, ROOM_Z0 + 0.015f, 0.98f, 1.1f, 0.03f, RGB(0x7a4a2c));
  panel(-0.55f, 1.44f, 0.35f, 2.46f, ROOM_Z0 + 0.035f, RGB(0xfbf3e6));
  /* The clock's body and face (its hands have bones). */
  {
    build_xf = aff_translate(CLOCK_X, CLOCK_Y, ROOM_Z0);
    Aff turn = aff_rot_x(PI / 2);
    build_xf = aff_then(build_xf, turn);
    cylinder(0, 0, 0, CLOCK_R + 0.05f, CLOCK_R + 0.05f, 0.06f, 32, RGB(0xd97757), RGB(0xd97757));
    build_xf = aff_identity();
    disc(CLOCK_X, CLOCK_Y, ROOM_Z0 + 0.065f, CLOCK_R, 32, RGB(0xfffdf8), false);
    for (int hour = 0; hour < 12; hour += 1) {
      float angle = 2 * PI * (float)hour / 12.0f;
      float r0 = CLOCK_R * (hour % 3 == 0 ? 0.74f : 0.82f), r1 = CLOCK_R * 0.92f;
      float dx = sinf(angle), dy = cosf(angle);
      float w = hour % 3 == 0 ? 0.022f : 0.012f;
      const float p[4][3] = {
        {CLOCK_X + dx * r0 - dy * w, CLOCK_Y + dy * r0 + dx * w, ROOM_Z0 + 0.07f},
        {CLOCK_X + dx * r0 + dy * w, CLOCK_Y + dy * r0 - dx * w, ROOM_Z0 + 0.07f},
        {CLOCK_X + dx * r1 + dy * w, CLOCK_Y + dy * r1 - dx * w, ROOM_Z0 + 0.07f},
        {CLOCK_X + dx * r1 - dy * w, CLOCK_Y + dy * r1 + dx * w, ROOM_Z0 + 0.07f},
      };
      quad(p, (const float[3]){0, 0, 1}, RGB(0x4a403a));
    }
  }
  /* The clock's hands turn about the clock's centre. */
  build_xf = aff_identity();
  build_bone = BONE_HOUR;
  box(0, CLOCK_R * 0.25f, 0.085f, 0.04f, CLOCK_R * 0.62f, 0.012f, RGB(0x2f2b29));
  build_bone = BONE_MINUTE;
  box(0, CLOCK_R * 0.38f, 0.1f, 0.026f, CLOCK_R * 0.9f, 0.012f, RGB(0x2f2b29));
  build_bone = BONE_ROOM;
  /* The rug under the cushion. */
  ring_up(SEAT_X, 0.004f, SEAT_Z + 0.1f, 0.0f, 1.32f, 40, RGB(0xa8c3a0));
  ring_up(SEAT_X, 0.006f, SEAT_Z + 0.1f, 1.02f, 1.16f, 40, RGB(0xf3e7d3));
  ring_up(SEAT_X, 0.006f, SEAT_Z + 0.1f, 0.58f, 0.66f, 40, RGB(0xf3e7d3));
  /* A bookshelf on the left wall. */
  {
    const float x = ROOM_X0 + 0.22f, z0 = -0.2f, depth = 0.4f, width = 1.3f;
    Color wood = RGB(0x8f5b3a);
    box(x, 0.9f, z0, depth, 1.8f, 0.05f, wood);
    box(x, 0.9f, z0 + width, depth, 1.8f, 0.05f, wood);
    for (int shelf = 0; shelf < 4; shelf += 1) {
      float y = 0.04f + shelf * 0.58f;
      box(x, y, z0 + width / 2, depth, 0.05f, width, wood);
    }
    static const uint32_t book_colors[] = {0xd97757, 0x5b7fa6, 0xe8c26a, 0x6e9e6f, 0xb85c6b, 0xefe6d6, 0x7a6bb0};
    for (int shelf = 0; shelf < 3; shelf += 1) {
      float y = 0.065f + shelf * 0.58f;
      float z = z0 + 0.06f;
      int count = 0;
      while (z < z0 + width - 0.12f) {
        uint32_t pick = random_next();
        float thickness = 0.07f + (float)(pick % 5) * 0.012f;
        float height = 0.32f + (float)((pick >> 4) % 4) * 0.04f;
        if ((pick >> 9) % 7 == 0 && count > 1) {
          z += 0.12f;
          count = 0;
          continue;
        }
        box(x + 0.02f, y + height / 2, z + thickness / 2, depth * 0.8f, height, thickness,
            RGB(book_colors[(pick >> 12) % 7]));
        z += thickness + 0.005f;
        count += 1;
      }
    }
  }
  /* A floor lamp in the right corner: pole and base (its shade is unlit). */
  cylinder(ROOM_X1 - 0.55f, 0.0f, ROOM_Z0 + 0.6f, 0.22f, 0.2f, 0.05f, 16, RGB(0x3b3a3f), RGB(0x3b3a3f));
  box(ROOM_X1 - 0.55f, 1.0f, ROOM_Z0 + 0.6f, 0.05f, 2.0f, 0.05f, RGB(0x3b3a3f));
}

static void build_room_outlined(void) {
  build_bone = BONE_ROOM;
  /* The cushion. */
  build_xf = aff_identity();
  cylinder(SEAT_X, 0.0f, SEAT_Z, 0.6f, 0.56f, SEAT_Y, 20, RGB(0x5d82ab), RGB(0x6d93bd));
  /* The side desk. */
  {
    build_xf = aff_translate(DESK_X, 0, DESK_Z);
    Color top = RGB(0x9a6845), leg = RGB(0x7a4f33);
    box(0, DESK_H - 0.04f, 0, DESK_W, 0.08f, DESK_D, top);
    for (int i = 0; i < 4; i += 1) {
      float x = (i & 1) ? DESK_W / 2 - 0.1f : -DESK_W / 2 + 0.1f;
      float z = (i & 2) ? DESK_D / 2 - 0.1f : -DESK_D / 2 + 0.1f;
      box(x, (DESK_H - 0.08f) / 2, z, 0.08f, DESK_H - 0.08f, 0.08f, leg);
    }
    /* A mug and a small book stack on the desk. */
    cylinder(DESK_W / 2 - 0.22f, DESK_H, DESK_D / 2 - 0.25f, 0.09f, 0.09f, 0.18f, 12, RGB(0xd97757), RGB(0x6b3c22));
    box(-DESK_W / 2 + 0.25f, DESK_H + 0.03f, DESK_D / 2 - 0.25f, 0.34f, 0.06f, 0.26f, RGB(0x5b7fa6));
    box(-DESK_W / 2 + 0.25f, DESK_H + 0.085f, DESK_D / 2 - 0.25f, 0.3f, 0.05f, 0.24f, RGB(0xe8c26a));
  }
  /* The monitor: base, neck, bezel, turned toward the cushion. */
  {
    Aff at = aff_translate(DESK_X - 0.05f, 0, DESK_Z - 0.05f);
    build_xf = aff_then(at, aff_rot_y(MONITOR_YAW));
    Color dark = RGB(0x2f2f35), stand = RGB(0x46464e);
    box(0, DESK_H + 0.02f, 0.0f, 0.5f, 0.04f, 0.32f, stand);
    box(0, DESK_H + 0.2f, -0.06f, 0.1f, 0.34f, 0.06f, stand);
    box(0, SCREEN_Y, -0.02f, SCREEN_W + 0.12f, SCREEN_H + 0.12f, 0.08f, dark);
  }
  /* The plant's pot. */
  build_xf = aff_identity();
  cylinder(PLANT_X, 0.0f, PLANT_Z, 0.26f, 0.34f, 0.5f, 14, RGB(0xc9663f), RGB(0x5a3a24));
  /* Leaves sway on their own bone, pivoting at the pot's rim. */
  build_bone = BONE_PLANT;
  build_xf = aff_identity();
  for (int i = 0; i < 7; i += 1) {
    float angle = (float)i * 2 * PI / 7 + 0.3f;
    float tilt = 0.45f + (float)(i % 3) * 0.18f;
    float length = 0.75f + (float)(i % 2) * 0.25f;
    Aff leaf = aff_then(aff_rot_y(angle), aff_rot_x(tilt));
    build_xf = leaf;
    box(0, length / 2, 0, 0.2f, length, 0.03f, (i % 2) ? RGB(0x4f9a5c) : RGB(0x3f8350));
  }
  build_bone = BONE_ROOM;
  build_xf = aff_identity();
}

/* The mascot, every part around its own pivot (the bones place them). The
 * eyes come last: they are lit but not outlined. */
static void build_mascot(void) {
  Color orange = RGB(0xd97757);
  build_xf = aff_identity();
  /* Body: its pivot is the bottom centre. */
  build_bone = BONE_BODY;
  box(0, 0.33f, 0, 1.0f, 0.66f, 0.62f, orange);
  /* Arms: pivot where each meets the body, reaching outward. */
  build_bone = BONE_ARM_L;
  box(-0.1f, 0, 0, 0.2f, 0.15f, 0.26f, orange);
  build_bone = BONE_ARM_R;
  box(0.1f, 0, 0, 0.2f, 0.15f, 0.26f, orange);
  /* Legs: pivot at the top of each leg. */
  for (int i = 0; i < 4; i += 1) {
    build_bone = (int8_t)(BONE_LEG0 + i);
    box(0, -LEG_H / 2, 0, 0.14f, LEG_H, 0.16f, orange);
  }
  build_bone = BONE_ROOM;
}

static void build_eyes(void) {
  Color eye = RGB(0x1c1a19);
  build_xf = aff_identity();
  build_bone = BONE_EYE_L;
  box(0, 0, 0, 0.11f, 0.22f, 0.04f, eye);
  build_bone = BONE_EYE_R;
  box(0, 0, 0, 0.11f, 0.22f, 0.04f, eye);
  build_bone = BONE_ROOM;
}

static void build_unlit(void) {
  build_xf = aff_identity();
  build_bone = BONE_ROOM;
  /* Sky in the window: bands from deep to pale blue, two clouds. */
  {
    const float x0 = -2.55f, x1 = -1.2f, y0 = 1.3f, y1 = 2.42f, z = ROOM_Z0 + 0.005f;
    static const uint32_t bands[] = {0x9fd0f5, 0xaed8f7, 0xbfe0f8, 0xd2e9fa, 0xe4f2fc};
    for (int i = 0; i < 5; i += 1) {
      float b0 = y1 - (y1 - y0) * (float)(i + 1) / 5.0f;
      float b1 = y1 - (y1 - y0) * (float)i / 5.0f;
      panel(x0, b0, x1, b1, z, RGB(bands[i]));
    }
    Color cloud = RGB(0xffffff);
    disc(-2.1f, 2.12f, z + 0.004f, 0.12f, 12, cloud, false);
    disc(-1.95f, 2.17f, z + 0.004f, 0.15f, 12, cloud, false);
    disc(-1.78f, 2.11f, z + 0.004f, 0.11f, 12, cloud, false);
    disc(-1.55f, 1.7f, z + 0.004f, 0.09f, 12, cloud, false);
    disc(-1.43f, 1.73f, z + 0.004f, 0.11f, 12, cloud, false);
  }
  /* Claude's spark on the poster, and a line of type under it. */
  spark(-0.1f, 2.06f, ROOM_Z0 + 0.04f, 0.3f, RGB(0xd97757));
  panel(-0.38f, 1.6f, 0.18f, 1.66f, ROOM_Z0 + 0.04f, RGB(0x3d3632));
  /* The lamp's shade, glowing. */
  {
    build_xf = aff_identity();
    cylinder(ROOM_X1 - 0.55f, 1.85f, ROOM_Z0 + 0.6f, 0.36f, 0.22f, 0.36f, 16, RGB(0xf7d27a), RGB(0xfbe6a8));
  }
  /* The monitor's power light. */
  {
    Aff at = aff_translate(DESK_X - 0.05f, 0, DESK_Z - 0.05f);
    build_xf = aff_then(at, aff_rot_y(MONITOR_YAW));
    box(SCREEN_W / 2 - 0.02f, SCREEN_Y - SCREEN_H / 2 - 0.035f, 0.025f, 0.03f, 0.02f, 0.01f, RGB(0x7ee08a));
    build_xf = aff_identity();
  }
}

static void build_screen(void) {
  Aff at = aff_translate(DESK_X - 0.05f, 0, DESK_Z - 0.05f);
  build_xf = aff_then(at, aff_rot_y(MONITOR_YAW));
  build_bone = BONE_ROOM;
  const float x0 = -SCREEN_W / 2, x1 = SCREEN_W / 2;
  const float y0 = SCREEN_Y - SCREEN_H / 2, y1 = SCREEN_Y + SCREEN_H / 2;
  const float z = 0.025f;
  const float p[4][3] = {{x0, y0, z}, {x1, y0, z}, {x1, y1, z}, {x0, y1, z}};
  /* (u, v): u left to right, v top to bottom; the texture matrix maps it. */
  const float uv[4][2] = {{0, 1}, {1, 1}, {1, 0}, {0, 0}};
  quad_uv(p, (const float[3]){0, 0, 1}, RGB(0xffffff), uv);
  build_xf = aff_identity();
}

/* The hint's quad in top-screen pixels (stage_render draws it orthographic),
 * the pill's bottom 8 px above the screen's and its right 8 px in. */
#define HINT_X (400.0f - 8.0f - STAGE_HINT_W)
#define HINT_Y (240.0f - 8.0f - STAGE_HINT_H)

static void build_hint(void) {
  build_xf = aff_identity();
  build_bone = BONE_ROOM;
  const float x0 = HINT_X, x1 = HINT_X + STAGE_HINT_TEX_W;
  const float y0 = HINT_Y, y1 = HINT_Y + STAGE_HINT_TEX_H;
  const float p[4][3] = {{x0, y0, 0}, {x1, y0, 0}, {x1, y1, 0}, {x0, y1, 0}};
  const float uv[4][2] = {{0, 0}, {1, 0}, {1, 1}, {0, 1}};
  quad_uv(p, (const float[3]){0, 0, 1}, RGB(0xffffff), uv);
}

static void build_shadows(void) {
  build_xf = aff_identity();
  build_bone = BONE_ROOM;
  Color soft = {40, 22, 12, 70};
  disc(SEAT_X, 0.012f, SEAT_Z + 0.05f, 0.78f, 24, soft, true);
  /* Under the desk. */
  {
    const float p[4][3] = {
      {DESK_X - DESK_W / 2 - 0.05f, 0.012f, DESK_Z + DESK_D / 2 + 0.08f},
      {DESK_X + DESK_W / 2 + 0.05f, 0.012f, DESK_Z + DESK_D / 2 + 0.08f},
      {DESK_X + DESK_W / 2 + 0.05f, 0.012f, DESK_Z - DESK_D / 2},
      {DESK_X - DESK_W / 2 - 0.05f, 0.012f, DESK_Z - DESK_D / 2},
    };
    quad(p, (const float[3]){0, 1, 0}, (Color){40, 22, 12, 46});
  }
  disc(PLANT_X, 0.012f, PLANT_Z, 0.42f, 16, soft, true);
  /* The mascot's own shadow on the cushion: a unit disc its bone scales. */
  build_bone = BONE_SHADOW;
  disc(0, 0, 0, 1.0f, 20, (Color){30, 18, 10, 90}, true);
  build_bone = BONE_ROOM;
}

// ---------------------------------------------------------------------------
// textures
// ---------------------------------------------------------------------------

#define TRANSFER_TO_TILED(fmt)                                                        \
  (GX_TRANSFER_FLIP_VERT(1) | GX_TRANSFER_OUT_TILED(1) | GX_TRANSFER_RAW_COPY(0) |   \
   GX_TRANSFER_IN_FORMAT(fmt) | GX_TRANSFER_OUT_FORMAT(fmt) |                         \
   GX_TRANSFER_SCALING(GX_TRANSFER_SCALE_NO))

static void upload_rgb565(C3D_Tex *texture, const uint16_t *linear) {
  GSPGPU_FlushDataCache(linear, texture->width * texture->height * 2);
  C3D_SyncDisplayTransfer(
    (u32 *)linear,
    GX_BUFFER_DIM(texture->width, texture->height),
    (u32 *)texture->data,
    GX_BUFFER_DIM(texture->width, texture->height),
    TRANSFER_TO_TILED(GX_TRANSFER_FMT_RGB565)
  );
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

bool stage_init(void) {
  if (initialized) return true;
  shader_blob = DVLB_ParseFile((u32 *)stage_shbin, stage_shbin_size);
  if (shader_blob == NULL) return false;
  shaderProgramInit(&program);
  shaderProgramSetVsh(&program, &shader_blob->DVLE[0]);
  u_proj = shaderInstanceGetUniformLocation(program.vertexShader, "proj");
  u_bones = shaderInstanceGetUniformLocation(program.vertexShader, "bones");
  u_light = shaderInstanceGetUniformLocation(program.vertexShader, "light");
  u_tone = shaderInstanceGetUniformLocation(program.vertexShader, "tone");
  u_outline = shaderInstanceGetUniformLocation(program.vertexShader, "outline");
  u_outcol = shaderInstanceGetUniformLocation(program.vertexShader, "outcol");
  u_uvs = shaderInstanceGetUniformLocation(program.vertexShader, "uvs");
  u_uvt = shaderInstanceGetUniformLocation(program.vertexShader, "uvt");
  if (u_proj < 0 || u_bones < 0 || u_light < 0 || u_tone < 0 || u_outline < 0 || u_outcol < 0 || u_uvs < 0 ||
      u_uvt < 0) {
    return false;
  }

  AttrInfo_Init(&attributes);
  AttrInfo_AddLoader(&attributes, 0, GPU_FLOAT, 3);
  AttrInfo_AddLoader(&attributes, 1, GPU_BYTE, 4);
  AttrInfo_AddLoader(&attributes, 2, GPU_UNSIGNED_BYTE, 4);
  AttrInfo_AddLoader(&attributes, 3, GPU_FLOAT, 2);
  AttrInfo_AddLoader(&attributes, 4, GPU_BYTE, 4);

  vertices = linearAlloc(MAX_VERTICES * sizeof *vertices);
  if (vertices == NULL) return false;
  vertex_count = 0;
  lit = begin_group();
  build_room_plain();
  outlined = begin_group();
  build_room_outlined();
  build_mascot();
  end_group(&outlined);
  build_eyes();
  lit.count = vertex_count - lit.first;
  unlit = begin_group();
  build_unlit();
  end_group(&unlit);
  screen = begin_group();
  build_screen();
  end_group(&screen);
  shadows = begin_group();
  build_shadows();
  end_group(&shadows);
  hint = begin_group();
  build_hint();
  end_group(&hint);
  GSPGPU_FlushDataCache(vertices, vertex_count * sizeof *vertices);

  BufInfo_Init(&buffers);
  if (BufInfo_Add(&buffers, vertices, sizeof *vertices, 5, 0x43210) < 0) return false;

  /* The touch screen's render target is 240 wide by 320 tall (rotated);
   * its copy lands in the top-left of a 256x512 texture. */
  if (!C3D_TexInit(&mirror_tex, 256, 512, GPU_RGBA8)) return false;
  C3D_TexSetFilter(&mirror_tex, GPU_LINEAR, GPU_LINEAR);
  C3D_TexSetWrap(&mirror_tex, GPU_CLAMP_TO_EDGE, GPU_CLAMP_TO_EDGE);
  memset(mirror_tex.data, 0, mirror_tex.size);
  if (!C3D_TexInit(&own_tex, 512, 256, GPU_RGB565)) return false;
  C3D_TexSetFilter(&own_tex, GPU_LINEAR, GPU_LINEAR);
  C3D_TexSetWrap(&own_tex, GPU_CLAMP_TO_EDGE, GPU_CLAMP_TO_EDGE);
  /* The clamped edge repeats the saver's plum border around the mark. */
  if (!C3D_TexInit(&saver_tex, STAGE_SAVER_W, STAGE_SAVER_H, GPU_RGB565)) return false;
  C3D_TexSetFilter(&saver_tex, GPU_LINEAR, GPU_LINEAR);
  C3D_TexSetWrap(&saver_tex, GPU_CLAMP_TO_EDGE, GPU_CLAMP_TO_EDGE);

  staging = linearAlloc(512 * 256 * sizeof *staging);
  if (staging == NULL) return false;
  memcpy(staging, stage_saver_pixels, sizeof stage_saver_pixels);
  upload_rgb565(&saver_tex, staging);

  if (!C3D_TexInit(&hint_tex, STAGE_HINT_TEX_W, STAGE_HINT_TEX_H, GPU_RGBA8)) return false;
  C3D_TexSetFilter(&hint_tex, GPU_NEAREST, GPU_NEAREST);
  C3D_TexSetWrap(&hint_tex, GPU_CLAMP_TO_EDGE, GPU_CLAMP_TO_EDGE);
  memcpy(staging, stage_hint_pixels, sizeof stage_hint_pixels);
  GSPGPU_FlushDataCache(staging, sizeof stage_hint_pixels);
  C3D_SyncDisplayTransfer(
    (u32 *)staging,
    GX_BUFFER_DIM(STAGE_HINT_TEX_W, STAGE_HINT_TEX_H),
    (u32 *)hint_tex.data,
    GX_BUFFER_DIM(STAGE_HINT_TEX_W, STAGE_HINT_TEX_H),
    TRANSFER_TO_TILED(GX_TRANSFER_FMT_RGBA8)
  );

  pose.eye_open = target.eye_open = 1.0f;
  pose.eye_size = target.eye_size = 1.0f;
  for (int i = 0; i < 4; i += 1) pose.leg[i] = target.leg[i] = LEG_REST;
  initialized = true;
  return true;
}

void stage_shutdown(void) {
  if (!initialized) return;
  C3D_TexDelete(&mirror_tex);
  C3D_TexDelete(&own_tex);
  C3D_TexDelete(&saver_tex);
  C3D_TexDelete(&hint_tex);
  linearFree(staging);
  linearFree(vertices);
  staging = NULL;
  vertices = NULL;
  shaderProgramFree(&program);
  DVLB_Free(shader_blob);
  shader_blob = NULL;
  initialized = false;
}

// ---------------------------------------------------------------------------
// guest-facing state
// ---------------------------------------------------------------------------

static void start_hop(float speed) {
  if (hop_y <= 0.001f) hop_v = speed;
}

void stage_set_mode(int next) {
  if (next < MODE_IDLE || next > MODE_HAPPY || next == mode) return;
  int previous = mode;
  mode = next;
  mode_since = frame;
  last_activity = frame;
  if (act == ACT_SLEEP) act = ACT_REST;
  if (next == MODE_ATTEND && previous == MODE_IDLE) start_hop(0.055f);
  if (next == MODE_HAPPY) start_hop(0.06f);
}

void stage_set_screen(int next) {
  if (next >= SCREEN_IDLE && next <= SCREEN_OWN) screen_source = next;
}

int stage_mode(void) {
  return mode;
}

void stage_set_level(float value) {
  level = clampf(value, 0.0f, 1.0f);
}

void stage_pulse(void) {
  squash_v -= 0.012f;
}

void stage_note_activity(void) {
  bool was_asleep = act == ACT_SLEEP;
  last_activity = frame;
  if (was_asleep) {
    act = ACT_REST;
    act_until = frame + 60;
    start_hop(0.045f);
    return;
  }
  /* Now and then the mascot turns to its monitor to watch what you do. */
  if (mode == MODE_IDLE && act != ACT_WATCH && (random_next() % 240) == 0) {
    act = ACT_WATCH;
    act_until = frame + 180 + random_next() % 120;
  }
}

// ---------------------------------------------------------------------------
// animation
// ---------------------------------------------------------------------------

/* The yaw that turns the mascot from the viewer toward its monitor. */
#define YAW_MONITOR 1.25f

static void pick_idle_act(void) {
  uint32_t roll = random_next() % 100;
  if (frame - last_activity > 60u * 75u) {
    act = ACT_SLEEP;
    act_until = UINT32_MAX;
    return;
  }
  if (roll < 32) {
    act = ACT_REST;
    act_until = frame + 90 + random_next() % 150;
  } else if (roll < 60) {
    act = ACT_LOOK;
    act_until = frame + 80 + random_next() % 120;
    target.yaw = random_range(-0.55f, 0.55f);
    target.eye_x = random_range(-0.04f, 0.04f);
    target.eye_y = random_range(-0.02f, 0.03f);
  } else if (roll < 78) {
    act = ACT_WATCH;
    act_until = frame + 150 + random_next() % 180;
  } else if (roll < 88) {
    act = ACT_KICK;
    act_until = frame + 70 + random_next() % 50;
  } else if (roll < 95) {
    act = ACT_STRETCH;
    act_until = frame + 75;
  } else {
    act = ACT_HOP;
    act_until = frame + 50;
    start_hop(0.05f);
  }
}

static void pose_targets(void) {
  float t = (float)frame / 60.0f;
  /* Defaults every mode starts from. */
  target.pitch = 0.0f;
  target.roll = 0.0f;
  target.eye_size = 1.0f;
  target.eye_open = 1.0f;
  for (int side = 0; side < 2; side += 1) {
    target.arm_raise[side] = 0.0f;
    target.arm_reach[side] = 0.0f;
  }
  for (int i = 0; i < 4; i += 1) target.leg[i] = LEG_REST;
  watching_user = false;

  switch (mode) {
    case MODE_IDLE:
    case MODE_HAPPY:
      if (mode == MODE_HAPPY && frame - mode_since > 90) {
        mode = MODE_IDLE;
        mode_since = frame;
      }
      if (frame >= act_until) pick_idle_act();
      switch (act) {
        case ACT_REST:
          target.yaw = ease(target.yaw, 0.0f, 0.02f);
          target.eye_x = 0.0f;
          target.eye_y = 0.0f;
          break;
        case ACT_LOOK:
          break;
        case ACT_WATCH:
          target.yaw = YAW_MONITOR;
          target.eye_x = 0.03f;
          target.eye_y = 0.02f;
          target.arm_reach[0] = target.arm_reach[1] = 1.1f;
          target.arm_raise[0] = -0.2f + 0.18f * sinf(t * 7.0f);
          target.arm_raise[1] = -0.2f + 0.18f * sinf(t * 7.0f + PI);
          watching_user = true;
          break;
        case ACT_KICK:
          for (int i = 0; i < 4; i += 1) target.leg[i] = LEG_REST + 0.45f * sinf(t * 9.0f + (float)i * PI * 0.5f);
          target.roll = 0.05f * sinf(t * 4.5f);
          break;
        case ACT_STRETCH: {
          float k = clampf((float)(act_until - frame) / 75.0f, 0.0f, 1.0f);
          float lift = sinf(k * PI);
          target.arm_raise[0] = target.arm_raise[1] = 1.5f * lift;
          target.pitch = -0.12f * lift;
          target.eye_open = 1.0f - 0.85f * lift;
          break;
        }
        case ACT_HOP:
          target.arm_raise[0] = target.arm_raise[1] = 0.6f;
          break;
        case ACT_SLEEP:
          target.yaw = ease(target.yaw, -0.15f, 0.01f);
          target.pitch = 0.16f;
          target.roll = -0.06f;
          target.eye_open = 0.08f;
          target.eye_x = 0.0f;
          target.eye_y = -0.03f;
          target.arm_raise[0] = target.arm_raise[1] = -0.25f;
          break;
      }
      if (mode == MODE_HAPPY) {
        target.yaw = 0.0f;
        target.arm_raise[0] = target.arm_raise[1] = 1.1f + 0.3f * sinf(t * 10.0f);
        target.eye_size = 1.1f;
        if ((frame - mode_since) % 36 == 0) start_hop(0.05f);
      }
      break;
    case MODE_ATTEND: {
      target.yaw = 0.0f;
      target.eye_x = 0.0f;
      target.eye_y = 0.01f;
      target.eye_size = 1.15f;
      /* A wave with the right arm for the first second. */
      uint32_t since = frame - mode_since;
      if (since < 70) {
        target.arm_raise[1] = 1.2f + 0.45f * sinf((float)since * 0.35f);
      } else {
        target.arm_raise[0] = target.arm_raise[1] = 0.2f;
      }
      break;
    }
    case MODE_LISTEN:
      target.yaw = 0.0f;
      target.pitch = 0.14f;
      target.eye_size = 1.2f + 0.25f * level;
      target.eye_y = 0.015f;
      target.arm_raise[0] = target.arm_raise[1] = 0.35f + 0.6f * level;
      break;
    case MODE_THINK:
    case MODE_ACT: {
      float rate = mode == MODE_ACT ? 11.0f : 7.0f;
      target.yaw = YAW_MONITOR;
      target.pitch = 0.06f;
      target.eye_x = 0.035f;
      target.eye_y = 0.02f;
      /* Both hands forward on the keys, tapping in turn. */
      typing_phase += rate / 60.0f;
      target.arm_reach[0] = target.arm_reach[1] = 1.1f;
      target.arm_raise[0] = -0.2f + 0.22f * sinf(typing_phase * 2 * PI);
      target.arm_raise[1] = -0.2f + 0.22f * sinf(typing_phase * 2 * PI + PI);
      if (mode == MODE_THINK) target.roll = 0.06f * sinf(t * 1.3f);
      break;
    }
    case MODE_SPEAK:
      target.yaw = 0.0f;
      target.eye_size = 1.08f;
      target.arm_raise[0] = 0.25f + 0.2f * sinf(t * 3.1f);
      target.arm_raise[1] = 0.25f + 0.2f * sinf(t * 3.1f + 1.7f);
      break;
  }
}

void stage_tick(void) {
  if (!initialized) return;
  frame += 1;
  pose_targets();

  /* Ease every channel toward its target. */
  float turn = mode == MODE_IDLE ? 0.06f : 0.12f;
  pose.yaw = ease(pose.yaw, target.yaw, turn);
  pose.pitch = ease(pose.pitch, target.pitch, 0.1f);
  pose.roll = ease(pose.roll, target.roll, 0.1f);
  pose.eye_x = ease(pose.eye_x, target.eye_x, 0.2f);
  pose.eye_y = ease(pose.eye_y, target.eye_y, 0.2f);
  pose.eye_size = ease(pose.eye_size, target.eye_size, 0.2f);
  pose.eye_open = ease(pose.eye_open, target.eye_open, 0.25f);
  for (int side = 0; side < 2; side += 1) {
    pose.arm_raise[side] = ease(pose.arm_raise[side], target.arm_raise[side], 0.3f);
    pose.arm_reach[side] = ease(pose.arm_reach[side], target.arm_reach[side], 0.15f);
  }
  for (int i = 0; i < 4; i += 1) pose.leg[i] = ease(pose.leg[i], target.leg[i], 0.2f);

  /* Blinks, except asleep. */
  if (frame >= blink_at && act != ACT_SLEEP) {
    blink_end = frame + 7;
    blink_at = frame + 100 + random_next() % 200;
  }

  /* Breathing on the squash spring's rest length; hops and pulses kick it. */
  float t = (float)frame / 60.0f;
  float breath = act == ACT_SLEEP ? 0.045f * sinf(t * 1.4f) : 0.022f * sinf(t * 2.2f);
  float rest = 1.0f + breath;
  if (mode == MODE_LISTEN) rest += 0.08f * level;
  squash_v += (rest - squash) * 0.18f;
  squash_v *= 0.78f;
  squash += squash_v;

  if (hop_v != 0.0f || hop_y > 0.0f) {
    hop_y += hop_v;
    hop_v -= 0.0045f;
    if (hop_y <= 0.0f) {
      hop_y = 0.0f;
      squash_v -= hop_v * 0.9f;
      hop_v = 0.0f;
    }
  }

  /* The screensaver drifts and turns back where its content meets an edge. */
  saver_x += saver_vx;
  saver_y += saver_vy;
  if (saver_x < SAVER_HALF_W || saver_x > 1.0f - SAVER_HALF_W) {
    saver_vx = -saver_vx;
    saver_x = clampf(saver_x, SAVER_HALF_W, 1.0f - SAVER_HALF_W);
  }
  if (saver_y < SAVER_HALF_H || saver_y > 1.0f - SAVER_HALF_H) {
    saver_vy = -saver_vy;
    saver_y = clampf(saver_y, SAVER_HALF_H, 1.0f - SAVER_HALF_H);
  }

  hint_alpha = ease(hint_alpha, mode == MODE_IDLE ? 1.0f : 0.0f, mode == MODE_IDLE ? 0.08f : 0.3f);
}

static void set_bone(int index, const Aff *bone) {
  C3D_FVec *rows = C3D_FVUnifWritePtr(GPU_VERTEX_SHADER, u_bones + index * 3, 3);
  for (int r = 0; r < 3; r += 1) {
    rows[r] = FVec4_New(bone->m[r][0], bone->m[r][1], bone->m[r][2], bone->m[r][3]);
  }
}

static void upload_bones(void) {
  Aff identity = aff_identity();
  for (int i = 0; i < BONE_COUNT; i += 1) set_bone(i, &identity);

  /* The clock: the companion's time when the link knows it. */
  {
    int64_t utc = 0;
    int32_t offset_min = 0;
    uint64_t ms;
    if (link_clock_now(&utc, &offset_min)) ms = (uint64_t)(utc + (int64_t)offset_min * 60000);
    else ms = osGetTime() - 2208988800000ull;
    float minutes = (float)((ms / 1000) % 3600) / 60.0f;
    float hours = (float)((ms / 60000) % 720) / 60.0f;
    Aff at = aff_translate(CLOCK_X, CLOCK_Y, ROOM_Z0);
    Aff hour = aff_then(at, aff_rot_z(-hours / 12.0f * 2 * PI));
    Aff minute = aff_then(at, aff_rot_z(-minutes / 60.0f * 2 * PI));
    set_bone(BONE_HOUR, &hour);
    set_bone(BONE_MINUTE, &minute);
  }
  {
    float t = (float)frame / 60.0f;
    Aff plant = aff_then(aff_translate(PLANT_X, 0.48f, PLANT_Z), aff_rot_z(0.035f * sinf(t * 0.9f)));
    set_bone(BONE_PLANT, &plant);
  }

  /* The mascot. Root: on the cushion, hop height, turned and leaning. */
  float squash_y = clampf(squash, 0.8f, 1.2f);
  float squash_xz = 1.0f / sqrtf(squash_y);
  Aff root = aff_translate(SEAT_X, SEAT_Y + LEG_H + hop_y, SEAT_Z);
  root = aff_then(root, aff_rot_y(pose.yaw));
  root = aff_then(root, aff_rot_x(pose.pitch));
  root = aff_then(root, aff_rot_z(pose.roll));
  Aff body = aff_then(root, aff_scale(squash_xz, squash_y, squash_xz));
  set_bone(BONE_BODY, &body);

  float blink = 1.0f;
  if (frame < blink_end) {
    float k = (float)(blink_end - frame) / 7.0f;
    blink = 0.1f + 0.9f * fabsf(k * 2.0f - 1.0f);
  }
  float open = clampf(pose.eye_open * blink, 0.06f, 1.3f);
  for (int side = 0; side < 2; side += 1) {
    float x = (side == 0 ? -0.21f : 0.21f) + pose.eye_x;
    Aff eye = aff_then(body, aff_translate(x, 0.43f + pose.eye_y, 0.315f));
    eye = aff_then(eye, aff_scale(pose.eye_size, pose.eye_size * open, 1.0f));
    set_bone(side == 0 ? BONE_EYE_L : BONE_EYE_R, &eye);
  }
  for (int side = 0; side < 2; side += 1) {
    float x = side == 0 ? -0.5f : 0.5f;
    float raise = side == 0 ? -pose.arm_raise[0] : pose.arm_raise[1];
    float reach = side == 0 ? pose.arm_reach[0] : -pose.arm_reach[1];
    Aff arm = aff_then(body, aff_translate(x, 0.24f, 0.02f));
    arm = aff_then(arm, aff_rot_y(reach));
    arm = aff_then(arm, aff_rot_z(raise));
    set_bone(side == 0 ? BONE_ARM_L : BONE_ARM_R, &arm);
  }
  static const float leg_x[4] = {-0.36f, -0.17f, 0.17f, 0.36f};
  for (int i = 0; i < 4; i += 1) {
    Aff leg = aff_then(root, aff_translate(leg_x[i], 0.02f, 0.04f));
    leg = aff_then(leg, aff_rot_x(pose.leg[i]));
    set_bone(BONE_LEG0 + i, &leg);
  }
  /* The shadow shrinks while the mascot is in the air. */
  float spread = 0.5f / (1.0f + hop_y * 4.0f);
  Aff shadow = aff_then(aff_translate(SEAT_X, SEAT_Y + 0.006f, SEAT_Z + 0.05f), aff_scale(spread * 1.1f, 1.0f, spread * 0.85f));
  set_bone(BONE_SHADOW, &shadow);
}

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

void stage_capture_mirror(C3D_RenderTarget *auxiliary) {
  if (!initialized || auxiliary == NULL) return;
  bool wanted = screen_source == SCREEN_MIRROR || watching_user;
  if (!wanted || (frame & 1u) != 0u) return;
  /* 8 rows of 240 RGBA8 pixels per tile row in, 256 per tile row out. */
  const uint32_t in_line = 240u * 8u * 4u;
  const uint32_t out_gap = (256u - 240u) * 8u * 4u;
  C3D_SyncTextureCopy(
    (u32 *)auxiliary->frameBuf.colorBuf,
    GX_BUFFER_DIM(in_line >> 4, 0),
    (u32 *)mirror_tex.data,
    GX_BUFFER_DIM(in_line >> 4, out_gap >> 4),
    in_line * (320u / 8u),
    GX_TRANSFER_RAW_COPY(1)
  );
  mirror_ready = true;
}

bool stage_own_frame(const uint8_t *pixels, uint32_t width, uint32_t height) {
  if (!initialized || width != 320 || height != 240) return false;
  for (uint32_t y = 0; y < height; y += 1) {
    memcpy(staging + y * 512, pixels + y * width * 2, width * 2);
  }
  upload_rgb565(&own_tex, staging);
  own_ready = true;
  return true;
}

static void set_tone(float dark, float bright, float threshold, float gradient) {
  C3D_FVUnifSet(GPU_VERTEX_SHADER, u_tone, dark, bright, threshold, gradient);
}

static void env_color_only(void) {
  C3D_TexEnv *env = C3D_GetTexEnv(0);
  C3D_TexEnvInit(env);
  C3D_TexEnvSrc(env, C3D_Both, GPU_PRIMARY_COLOR, 0, 0);
  C3D_TexEnvFunc(env, C3D_Both, GPU_REPLACE);
}

static void env_textured(void) {
  C3D_TexEnv *env = C3D_GetTexEnv(0);
  C3D_TexEnvInit(env);
  C3D_TexEnvSrc(env, C3D_Both, GPU_TEXTURE0, GPU_PRIMARY_COLOR, 0);
  C3D_TexEnvFunc(env, C3D_Both, GPU_MODULATE);
}

static void draw_range(Range range) {
  if (range.count > 0) C3D_DrawArrays(GPU_TRIANGLES, (int)range.first, (int)range.count);
}

/* The monitor's texture and its texture matrix for the current source. */
static void bind_screen(void) {
  int source = screen_source;
  if (source == SCREEN_IDLE && watching_user) source = SCREEN_MIRROR;
  if (source == SCREEN_MIRROR && !mirror_ready) source = SCREEN_IDLE;
  if (source == SCREEN_OWN && !own_ready) source = SCREEN_IDLE;
  if (source == SCREEN_MIRROR) {
    /* Logical (u, v) to the rotated render target's copy: the target's
     * columns run along the screen's height, its rows along the width. */
    C3D_TexBind(0, &mirror_tex);
    C3D_FVUnifSet(GPU_VERTEX_SHADER, u_uvs, 0.0f, -240.0f / 256.0f, 240.0f / 256.0f, 0.0f);
    C3D_FVUnifSet(GPU_VERTEX_SHADER, u_uvt, -320.0f / 512.0f, 0.0f, 1.0f, 0.0f);
  } else if (source == SCREEN_OWN) {
    C3D_TexBind(0, &own_tex);
    C3D_FVUnifSet(GPU_VERTEX_SHADER, u_uvs, 320.0f / 512.0f, 0.0f, 0.0f, 0.0f);
    C3D_FVUnifSet(GPU_VERTEX_SHADER, u_uvt, 0.0f, -240.0f / 256.0f, 1.0f, 0.0f);
  } else {
    /* The screen's (u, v) maps to the saver's (x, y) about its centre. */
    const float su = 1.0f / SAVER_SPAN_W;
    const float sv = 1.0f / SAVER_SPAN_H;
    C3D_TexBind(0, &saver_tex);
    C3D_FVUnifSet(GPU_VERTEX_SHADER, u_uvs, su, 0.0f, 0.5f - saver_x * su, 0.0f);
    C3D_FVUnifSet(GPU_VERTEX_SHADER, u_uvt, 0.0f, sv, 0.5f - saver_y * sv, 0.0f);
  }
}

static void draw_eye(float iod) {
  C3D_Mtx projection, view, mvp;
  /* The viewer sits in front of the room, a little above the mascot. */
  Mtx_PerspStereoTilt(&projection, C3D_AngleFromDegrees(40.0f), C3D_AspectRatioTop, 0.2f, 20.0f, iod, 3.6f, false);
  Mtx_LookAt(&view, FVec3_New(0.35f, 1.5f, 3.35f), FVec3_New(0.35f, 0.92f, -0.85f), FVec3_New(0, 1, 0), false);
  Mtx_Multiply(&mvp, &projection, &view);
  C3D_FVUnifMtx4x4(GPU_VERTEX_SHADER, u_proj, &mvp);

  /* Lit geometry, then the outlines, with back faces culled. */
  env_color_only();
  C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_ONE, GPU_ZERO, GPU_ONE, GPU_ZERO);
  C3D_DepthTest(true, GPU_GREATER, GPU_WRITE_ALL);
  C3D_CullFace(GPU_CULL_BACK_CCW);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, u_outline, 0.0f, 0.0f, 0.0f, 0.0f);
  set_tone(0.74f, 0.96f, 0.22f, 0.1f);
  draw_range(lit);

  C3D_CullFace(GPU_CULL_FRONT_CCW);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, u_outline, 0.022f, 1.0f, 0.0f, 0.0f);
  draw_range(outlined);

  C3D_CullFace(GPU_CULL_BACK_CCW);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, u_outline, 0.0f, 0.0f, 0.0f, 0.0f);
  set_tone(1.0f, 1.0f, 0.0f, 0.0f);
  draw_range(unlit);

  env_textured();
  bind_screen();
  draw_range(screen);

  /* Shadows blend over the floor without writing depth. */
  env_color_only();
  C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_SRC_ALPHA, GPU_ONE_MINUS_SRC_ALPHA, GPU_ONE, GPU_ZERO);
  C3D_DepthTest(true, GPU_GREATER, GPU_WRITE_COLOR);
  set_tone(1.0f, 1.0f, 0.0f, 0.0f);
  draw_range(shadows);
}

/* The hint, at the screen's pixels in either eye. */
static void draw_hint(void) {
  if (hint_alpha < 0.01f) return;
  C3D_Mtx projection;
  Mtx_OrthoTilt(&projection, 0.0f, 400.0f, 240.0f, 0.0f, 1.0f, -1.0f, true);
  C3D_FVUnifMtx4x4(GPU_VERTEX_SHADER, u_proj, &projection);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, u_outline, 0.0f, 0.0f, 0.0f, 0.0f);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, u_uvs, 1.0f, 0.0f, 0.0f, 0.0f);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, u_uvt, 0.0f, 1.0f, 0.0f, 0.0f);
  set_tone(1.0f, 1.0f, 0.0f, 0.0f);
  C3D_TexBind(0, &hint_tex);
  C3D_TexEnv *env = C3D_GetTexEnv(0);
  C3D_TexEnvInit(env);
  C3D_TexEnvSrc(env, C3D_RGB, GPU_TEXTURE0, GPU_PRIMARY_COLOR, 0);
  C3D_TexEnvFunc(env, C3D_RGB, GPU_MODULATE);
  C3D_TexEnvSrc(env, C3D_Alpha, GPU_TEXTURE0, GPU_CONSTANT, 0);
  C3D_TexEnvFunc(env, C3D_Alpha, GPU_MODULATE);
  C3D_TexEnvColor(env, ((uint32_t)(hint_alpha * 255.0f) << 24) | 0xffffffu);
  C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_SRC_ALPHA, GPU_ONE_MINUS_SRC_ALPHA, GPU_ONE, GPU_ZERO);
  C3D_DepthTest(false, GPU_ALWAYS, GPU_WRITE_COLOR);
  C3D_CullFace(GPU_CULL_NONE);
  draw_range(hint);
}

bool stage_render(C3D_RenderTarget *left, C3D_RenderTarget *right) {
  if (!initialized) return false;
  u64 started = svcGetSystemTick();
  C3D_BindProgram(&program);
  C3D_SetAttrInfo(&attributes);
  C3D_SetBufInfo(&buffers);
  /* Light from the window's side, above and in front. */
  C3D_FVUnifSet(GPU_VERTEX_SHADER, u_light, -0.42f, 0.78f, 0.46f, 0.0f);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, u_outcol, 0.24f, 0.13f, 0.09f, 1.0f);
  upload_bones();

  float slider = osGet3DSliderState();
  float iod = slider * 0.22f;
  C3D_FrameDrawOn(left);
  C3D_SetViewport(0, 0, 240, 400);
  draw_eye(-iod);
  draw_hint();
  bool stereo = right != NULL && iod > 0.0f;
  if (stereo) {
    C3D_FrameDrawOn(right);
    C3D_SetViewport(0, 0, 240, 400);
    draw_eye(iod);
    draw_hint();
  }
  C3D_DepthTest(false, GPU_ALWAYS, GPU_WRITE_COLOR);
  C3D_CullFace(GPU_CULL_NONE);
  last_us = (uint32_t)((svcGetSystemTick() - started) * 1000000u / SYSCLOCK_ARM11);
  return stereo;
}

uint32_t stage_last_us(void) {
  return last_us;
}

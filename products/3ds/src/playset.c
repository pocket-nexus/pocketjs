/* `globalThis.playset` (playset.h): the guest's bindings to one pocket-playset
 * world, and the scene's draw under the top screen's DrawList.
 *
 * Every function takes numbers or Float32Arrays and returns a number, except
 * view(), which returns a Float32Array aliasing the world's memory. Those
 * buffers have no free function: the memory belongs to the world, which is
 * destroyed only after the realm that holds the views. */
#include "playset.h"

#include <3ds.h>
#include <pocket_3ds_playset.h>
#include <pocket_playset.h>
#include <string.h>

#include "playset_shbin.h"

static bool admitted;
static pps *world;
static p3ps_renderer *renderer;
static p3ps_stats last_stats;

typedef enum {
  OpInit,
  OpView,
  OpModel,
  OpNode,
  OpNodeSet,
  OpNodeMatrix,
  OpNodeRemove,
  OpEnv,
  OpTerrain,
  OpCollider,
  OpCollidersClear,
  OpLod,
  OpArch,
  OpArchSet,
  OpRule,
  OpRulesClear,
  OpPath,
  OpEmitter,
  OpSpawn,
  OpKill,
  OpRevive,
  OpAttach,
  OpLayer,
  OpEmit,
  OpFire,
  OpStep,
  OpCamera,
  OpQuery,
  OpSeed,
  OpClear,
  OpNow,
  OpRenderStats,
} Op;

void playset_admit(bool value) { admitted = value; }
bool playset_admitted(void) { return admitted; }
bool playset_active(void) { return world != NULL; }

static double num(JSContext *ctx, int argc, JSValueConst *argv, int i) {
  double v = 0;
  if (i < argc) JS_ToFloat64(ctx, &v, argv[i]);
  return v;
}

static float *floats(JSContext *ctx, int argc, JSValueConst *argv, int i,
                     uint32_t *count) {
  *count = 0;
  if (i >= argc || !JS_IsObject(argv[i])) return NULL;
  size_t offset = 0, length = 0, per = 0;
  JSValue buffer =
      JS_GetTypedArrayBuffer(ctx, argv[i], &offset, &length, &per);
  if (JS_IsException(buffer)) {
    JS_FreeValue(ctx, JS_GetException(ctx));
    return NULL;
  }
  size_t size = 0;
  uint8_t *bytes = JS_GetArrayBuffer(ctx, &size, buffer);
  JS_FreeValue(ctx, buffer);
  if (!bytes || per != 4 || offset + length > size) return NULL;
  *count = (uint32_t)(length / 4);
  return (float *)(bytes + offset);
}

static JSValue view(JSContext *ctx, uint32_t which) {
  uint32_t length = 0;
  float *data = pps_view(world, which, &length);
  if (!data || length == 0) return JS_NULL;
  JSValue buffer = JS_NewArrayBuffer(ctx, (uint8_t *)data, length * 4, NULL,
                                     NULL, 0);
  if (JS_IsException(buffer)) return buffer;
  /* `new Float32Array(buffer)` through the global constructor: this QuickJS
   * faults in JS_NewTypedArray, which passes no new.target. */
  JSValue global = JS_GetGlobalObject(ctx);
  JSValue ctor = JS_GetPropertyStr(ctx, global, "Float32Array");
  JS_FreeValue(ctx, global);
  JSValue array = JS_CallConstructor(ctx, ctor, 1, (JSValueConst *)&buffer);
  JS_FreeValue(ctx, ctor);
  JS_FreeValue(ctx, buffer);
  return array;
}

static JSValue call(JSContext *ctx, JSValueConst this_value, int argc,
                    JSValueConst *argv, int magic) {
  (void)this_value;
  if (magic == OpInit) {
    if (!world) {
      uint32_t cap = (uint32_t)num(ctx, argc, argv, 0);
      uint32_t particles = (uint32_t)num(ctx, argc, argv, 1);
      world = pps_create(cap ? cap : 256, argc > 1 ? particles : 512);
    }
    return JS_NewBool(ctx, world != NULL);
  }
  if (magic == OpNow)
    return JS_NewFloat64(ctx, (double)svcGetSystemTick() * 1e6 / SYSCLOCK_ARM11);
  if (!world) return JS_ThrowTypeError(ctx, "playset.init() first");
  uint32_t n = 0;
  float *f;
  float xf[7];
  switch ((Op)magic) {
  case OpView:
    return view(ctx, (uint32_t)num(ctx, argc, argv, 0));
  case OpModel:
    f = floats(ctx, argc, argv, 0, &n);
    return JS_NewInt32(ctx, f ? pps_model(world, f, n) : -1);
  case OpNode:
  case OpNodeSet:
    for (int i = 0; i < 7; i++) xf[i] = (float)num(ctx, argc, argv, i + 1);
    if (magic == OpNode)
      return JS_NewInt32(ctx, pps_node(world, (int32_t)num(ctx, argc, argv, 0), xf,
                                       (uint32_t)num(ctx, argc, argv, 8) & 0x7fffffffu));
    pps_node_set(world, (int32_t)num(ctx, argc, argv, 0), xf,
                 (uint32_t)num(ctx, argc, argv, 8) & 0x7fffffffu);
    return JS_UNDEFINED;
  case OpNodeMatrix: {
    /* nodeMatrix(node | -1, model, m12, flags): a new node when node < 0 */
    f = floats(ctx, argc, argv, 2, &n);
    if (!f || n < 12) return JS_NewInt32(ctx, -1);
    int32_t node = (int32_t)num(ctx, argc, argv, 0);
    uint32_t flags = ((uint32_t)num(ctx, argc, argv, 3) & 0x7fffffffu) | 0x80000000u;
    if (node < 0)
      return JS_NewInt32(ctx, pps_node(world, (int32_t)num(ctx, argc, argv, 1), f, flags));
    pps_node_set(world, node, f, flags);
    return JS_NewInt32(ctx, node);
  }
  case OpNodeRemove:
    pps_node_remove(world, (int32_t)num(ctx, argc, argv, 0));
    return JS_UNDEFINED;
  case OpEnv:
    f = floats(ctx, argc, argv, 1, &n);
    pps_env(world, (uint32_t)num(ctx, argc, argv, 0), f, n);
    return JS_UNDEFINED;
  case OpTerrain: {
    uint32_t hn = 0, bn = 0;
    float origin[3] = {(float)num(ctx, argc, argv, 3), (float)num(ctx, argc, argv, 4),
                       (float)num(ctx, argc, argv, 5)};
    float *heights = floats(ctx, argc, argv, 6, &hn);
    float *bands = floats(ctx, argc, argv, 7, &bn);
    pps_terrain(world, (uint32_t)num(ctx, argc, argv, 0), (uint32_t)num(ctx, argc, argv, 1),
                (float)num(ctx, argc, argv, 2), origin, heights, hn, bands, bn);
    return JS_UNDEFINED;
  }
  case OpCollider:
    f = floats(ctx, argc, argv, 1, &n);
    return JS_NewInt32(ctx, pps_collider(world, (uint32_t)num(ctx, argc, argv, 0), f, n));
  case OpCollidersClear:
    pps_colliders_clear(world);
    return JS_UNDEFINED;
  case OpLod:
    pps_lod(world, (uint32_t)num(ctx, argc, argv, 0), (uint32_t)num(ctx, argc, argv, 1),
            (uint32_t)num(ctx, argc, argv, 2));
    return JS_UNDEFINED;
  case OpArch:
    f = floats(ctx, argc, argv, 0, &n);
    return JS_NewInt32(ctx, f ? pps_arch(world, f, n) : -1);
  case OpArchSet:
    f = floats(ctx, argc, argv, 1, &n);
    if (f) pps_arch_set(world, (int32_t)num(ctx, argc, argv, 0), f, n);
    return JS_UNDEFINED;
  case OpRule:
    return JS_NewInt32(ctx, pps_rule(world, (uint32_t)num(ctx, argc, argv, 0),
                                     (uint32_t)num(ctx, argc, argv, 1),
                                     (uint32_t)num(ctx, argc, argv, 2),
                                     (float)num(ctx, argc, argv, 3)));
  case OpRulesClear:
    pps_rules_clear(world);
    return JS_UNDEFINED;
  case OpPath:
    f = floats(ctx, argc, argv, 0, &n);
    return JS_NewInt32(ctx, f ? pps_path(world, f, n) : -1);
  case OpEmitter:
    f = floats(ctx, argc, argv, 0, &n);
    return JS_NewInt32(ctx, f ? pps_emitter(world, f, n) : -1);
  case OpSpawn:
    return JS_NewInt32(ctx, pps_spawn(world, (int32_t)num(ctx, argc, argv, 0),
                                      (float)num(ctx, argc, argv, 1), (float)num(ctx, argc, argv, 2),
                                      (float)num(ctx, argc, argv, 3), (float)num(ctx, argc, argv, 4)));
  case OpKill:
    pps_kill(world, (int32_t)num(ctx, argc, argv, 0), (int32_t)num(ctx, argc, argv, 1));
    return JS_UNDEFINED;
  case OpRevive:
    pps_revive(world, (int32_t)num(ctx, argc, argv, 0), (float)num(ctx, argc, argv, 1));
    return JS_UNDEFINED;
  case OpAttach:
    pps_attach(world, (int32_t)num(ctx, argc, argv, 0), (int32_t)num(ctx, argc, argv, 1),
               (float)num(ctx, argc, argv, 2), (float)num(ctx, argc, argv, 3),
               (float)num(ctx, argc, argv, 4), (float)num(ctx, argc, argv, 5),
               (int32_t)num(ctx, argc, argv, 6));
    return JS_UNDEFINED;
  case OpLayer:
    pps_layer(world, (int32_t)num(ctx, argc, argv, 0), (uint32_t)num(ctx, argc, argv, 1),
              (uint32_t)num(ctx, argc, argv, 2), (int32_t)num(ctx, argc, argv, 3));
    return JS_UNDEFINED;
  case OpEmit:
    pps_emit(world, (int32_t)num(ctx, argc, argv, 0), (float)num(ctx, argc, argv, 1),
             (float)num(ctx, argc, argv, 2), (float)num(ctx, argc, argv, 3),
             argc > 4 ? (float)num(ctx, argc, argv, 4) : 1.0f);
    return JS_UNDEFINED;
  case OpFire:
    pps_fire(world, (int32_t)num(ctx, argc, argv, 0), (int32_t)num(ctx, argc, argv, 1));
    return JS_UNDEFINED;
  case OpStep: {
    u64 t0 = svcGetSystemTick();
    int32_t events = pps_step(world, (float)num(ctx, argc, argv, 0));
    u64 t1 = svcGetSystemTick();
    pps_note_timing(world, (float)((t1 - t0) * 1000000ull / SYSCLOCK_ARM11), -1, -1);
    return JS_NewInt32(ctx, events);
  }
  case OpCamera:
    f = floats(ctx, argc, argv, 0, &n);
    if (f) pps_camera(world, f, n);
    return JS_UNDEFINED;
  case OpQuery:
    return JS_NewFloat64(ctx, pps_query(world, (uint32_t)num(ctx, argc, argv, 0),
                                        (float)num(ctx, argc, argv, 1), (float)num(ctx, argc, argv, 2),
                                        (float)num(ctx, argc, argv, 3), (float)num(ctx, argc, argv, 4)));
  case OpSeed:
    pps_seed(world, (uint32_t)num(ctx, argc, argv, 0));
    return JS_UNDEFINED;
  case OpClear:
    pps_clear(world);
    return JS_UNDEFINED;
  case OpRenderStats:
    /* draws, bone matrices, uploads, dynamic vertices, triangles */
    f = floats(ctx, argc, argv, 0, &n);
    if (f && n >= 5) {
      f[0] = (float)last_stats.draws;
      f[1] = (float)last_stats.bones;
      f[2] = (float)last_stats.uploads;
      f[3] = (float)last_stats.dyn_vertices;
      f[4] = (float)last_stats.tris;
    }
    return JS_UNDEFINED;
  default:
    return JS_UNDEFINED;
  }
}

int playset_install(JSContext *ctx, JSValueConst global) {
  if (!admitted) return 0;
  static const struct {
    const char *name;
    int arity;
    Op op;
  } ops[] = {
      {"init", 2, OpInit},         {"view", 1, OpView},
      {"model", 1, OpModel},       {"node", 9, OpNode},
      {"nodeSet", 9, OpNodeSet},   {"nodeMatrix", 4, OpNodeMatrix},
      {"nodeRemove", 1, OpNodeRemove}, {"env", 2, OpEnv},
      {"terrain", 8, OpTerrain},   {"collider", 2, OpCollider},
      {"collidersClear", 0, OpCollidersClear}, {"lod", 3, OpLod},
      {"arch", 1, OpArch},         {"archSet", 2, OpArchSet},
      {"rule", 4, OpRule},         {"rulesClear", 0, OpRulesClear},
      {"path", 1, OpPath},         {"emitter", 1, OpEmitter},
      {"spawn", 5, OpSpawn},       {"kill", 2, OpKill},
      {"revive", 2, OpRevive},     {"attach", 7, OpAttach},
      {"layer", 4, OpLayer},       {"emit", 5, OpEmit},
      {"fire", 2, OpFire},         {"step", 1, OpStep},
      {"camera", 1, OpCamera},     {"query", 5, OpQuery},
      {"seed", 1, OpSeed},         {"clear", 0, OpClear},
      {"now", 0, OpNow},           {"renderStats", 1, OpRenderStats},
  };
  JSValue ns = JS_NewObject(ctx);
  if (JS_IsException(ns)) return -1;
  for (size_t i = 0; i < sizeof ops / sizeof ops[0]; i++) {
    JSValue fn = JS_NewCFunctionMagic(ctx, call, ops[i].name, ops[i].arity,
                                      JS_CFUNC_generic_magic, ops[i].op);
    if (JS_IsException(fn) || JS_SetPropertyStr(ctx, ns, ops[i].name, fn) < 0) {
      JS_FreeValue(ctx, ns);
      return -1;
    }
  }
  return JS_SetPropertyStr(ctx, global, "playset", ns) < 0 ? -1 : 0;
}

void playset_shutdown(void) {
  if (renderer) p3ps_forget(renderer);
  if (world) {
    pps_destroy(world);
    world = NULL;
  }
  memset(&last_stats, 0, sizeof last_stats);
}

bool playset_render(C3D_RenderTarget *target, C3D_RenderTarget *right) {
  if (!world) return false;
  if (!renderer) {
    renderer = p3ps_create(playset_shbin, playset_shbin_size);
    if (!renderer) return false;
  }
  u64 t0 = svcGetSystemTick();
  bool stereo = right && gfxIs3D();
  float slider = osGet3DSliderState();
  bool ok = p3ps_render(renderer, world, target, stereo && slider > 0.0f ? right : NULL,
                        slider * 0.4f, &last_stats);
  u64 t1 = svcGetSystemTick();
  pps_note_timing(world, -1, -1, (float)((t1 - t0) * 1000000ull / SYSCLOCK_ARM11));
  return ok;
}

/* Three folding props: two share a two-joint mesh, one has three joints.
 * No application runtime, character assets, UI guest or QuickJS is linked. */
#include "pocket3d.h"
#include "color_shbin.h"
#include "skin_shbin.h"
#include <citro2d.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

static bool create_prop(P3D_SkinMesh *mesh, unsigned joints) {
  P3D_RigidVertex vertices[9];
  uint16_t indices[9];
  P3D_RigidRange ranges[3];
  const float positions[3][3] = {{-.3f, 0, 0}, {.3f, 0, 0}, {0, .65f, 0}};
  for (unsigned j = 0; j < joints; j++) {
    ranges[j] = (P3D_RigidRange){j * 3, 3, {j, j, j}, 0};
    for (unsigned i = 0; i < 3; i++) {
      unsigned k = j * 3 + i;
      vertices[k] = (P3D_RigidVertex){
        {positions[i][0], positions[i][1], 0}, {0, 0, 1},
        {joints == 2 ? 1.f : .35f, .7f, joints == 3 ? 1.f : .3f}, j * 3.f};
      indices[k] = k;
    }
  }
  P3D_SkinSource source = {vertices, indices, ranges, joints * 3, joints * 3, joints, joints};
  /* Validate external-source bounds before allocating resident GPU memory. */
  P3D_SkinMesh bad;
  indices[0] = 99;
  if (p3d_skin_create(&bad, &source)) return false;
  indices[0] = 0;
  source.joint_count = P3D_SKIN_MAX_JOINTS + 1;
  if (p3d_skin_create(&bad, &source)) return false;
  source.joint_count = joints;
  return p3d_skin_create(mesh, &source);
}

static void pose(P3D_SkinMatrix *out, unsigned joints, float x, float phase) {
  float y = -.7f, angle = 0;
  for (unsigned j = 0; j < joints; j++) {
    angle += sinf(phase + j * .9f) * .45f;
    float c = cosf(angle), s = sinf(angle);
    out[j] = (P3D_SkinMatrix){{{c,-s,0,x},{s,c,0,y},{0,0,1,0}}};
    x -= .65f * s;
    y += .65f * c;
  }
}

int main(void) {
  gfxInitDefault();
  gfxSet3D(false);
  if (!C3D_Init(C3D_DEFAULT_CMDBUF_SIZE) || !C2D_Init(64)) return 1;
  C3D_RenderTarget *top = C2D_CreateScreenTarget(GFX_TOP, GFX_LEFT);
  if (!top || !p3d_init(color_shbin, color_shbin_size) ||
      !p3d_skin_init(skin_shbin, skin_shbin_size)) return 2;
  P3D_SkinMesh two, three;
  if (!create_prop(&two, 2) || !create_prop(&three, 3)) return 3;
  C3D_Mtx projection;
  Mtx_OrthoTilt(&projection, -2.5f, 2.5f, -1.5f, 1.5f, -1, 1, false);
  const P3D_SkinLight lights[] = {{{0,1,1}, .2f,.8f}, {{0,0,0}, 1,0}, {{0,0,0}, 0,0}};
#ifdef P3D_CAPTURE
  mkdir("sdmc:/p3d-rigid", 0777);
  uint8_t *capture = linearAlloc(400 * 240 * 3);
  if (!capture) return 4;
#endif
  unsigned frame = 0;
  while (aptMainLoop()) {
    hidScanInput();
    if (hidKeysDown() & KEY_START) break;
    if (!C3D_FrameBegin(C3D_FRAME_SYNCDRAW)) continue;
    C3D_RenderTargetClear(top, C3D_CLEAR_ALL, 0x1d2738ff, 0);
    C3D_FrameDrawOn(top);
    p3d_begin(&projection);
    unsigned light = (frame / 30) % 3;
    P3D_SkinLight invalid = {{0,0,0}, .5f, .5f};
    if (p3d_skin_begin(&projection, &invalid) || !p3d_skin_begin(&projection, &lights[light])) return 5;
    for (unsigned actor = 0; actor < 3; actor++) {
      P3D_SkinMatrix palette[3];
      const P3D_SkinMesh *mesh = actor == 2 ? &three : &two;
      pose(palette, mesh->joint_count, (actor - 1.f) * 1.5f, frame * .05f + actor);
      if (frame >= 30 && actor == 1) memset(&palette[1], 0, sizeof palette[1]);
      uint32_t visible = p3d_skin_visible(palette, mesh->joint_count);
      unsigned expected = (mesh->joint_count - (frame >= 30 && actor == 1)) * 3;
      if (p3d_skin_count(mesh, visible) != expected) return 6;
      p3d_skin_draw(mesh, palette, visible);
    }
    C3D_FrameEnd(0);
    frame++;
#ifdef P3D_CAPTURE
    if (frame == 1 || frame == 31 || frame == 61) {
      C3D_SyncDisplayTransfer((u32 *)top->frameBuf.colorBuf, GX_BUFFER_DIM(240,400),
        (u32 *)capture, GX_BUFFER_DIM(240,400), GX_TRANSFER_IN_FORMAT(GX_TRANSFER_FMT_RGBA8) |
        GX_TRANSFER_OUT_FORMAT(GX_TRANSFER_FMT_RGB8));
      GSPGPU_InvalidateDataCache(capture, 400 * 240 * 3);
      char path[80]; snprintf(path, sizeof path, "sdmc:/p3d-rigid/frame-%u.bgr", frame);
      FILE *f = fopen(path, "wb");
      if (!f || fwrite(capture, 1, 400 * 240 * 3, f) != 400 * 240 * 3 || fclose(f)) return 7;
    }
    if (frame == 61) {
      FILE *f = fopen("sdmc:/p3d-rigid/done", "w");
      if (!f) return 8;
      fputs("two rigs, shared mesh, hidden joint, three lights, invalid input: pass\n", f);
      fclose(f); break;
    }
#endif
  }
  C3D_FrameSync();
  p3d_skin_free(&two); p3d_skin_free(&three);
  p3d_exit();
#ifdef P3D_CAPTURE
  linearFree(capture);
#endif
  C2D_Fini(); C3D_Fini(); gfxExit();
  return 0;
}

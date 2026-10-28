#ifndef POCKETJS_3DS_PLAYSET_H
#define POCKETJS_3DS_PLAYSET_H

#include <citro3d.h>
#include <quickjs.h>
#include <stdbool.h>

/* `globalThis.playset` for a guest that declared "game.playset"
 * (contracts/spec/playset.ts, docs/PLAYSET.md). main.c admits it before
 * qjs_boot; qjs.c installs the namespace; gfx.c draws the scene under the
 * guest's top-screen DrawList. */
void playset_admit(bool admitted);
bool playset_admitted(void);
int playset_install(JSContext *ctx, JSValueConst global);
/* After the guest's realm is freed: the world and its GPU copies go. The GPU
 * must be idle. */
void playset_shutdown(void);
/* Draws the scene into the primary target when the guest made one. */
bool playset_render(C3D_RenderTarget *target, C3D_RenderTarget *right);
bool playset_active(void);

#endif

#ifndef POCKETJS_3DS_GFX_H
#define POCKETJS_3DS_GFX_H
#include <citro3d.h>
#include <pocket_runtime.h>
/* Product composition around the independent PICA Renderer and Displays. */
bool gfx_init(uint32_t width, uint32_t height);
bool gfx_bind_targets(C3D_RenderTarget *primary, C3D_RenderTarget *auxiliary,
                      C3D_RenderTarget *right, uint32_t width, uint32_t height,
                      uint32_t auxiliary_width, uint32_t auxiliary_height);
bool gfx_register(pocket_runtime *runtime);
void gfx_reset_resources(void);
void gfx_shutdown(void);
uint32_t gfx_dropped_vertices(void);
uint32_t gfx_frame_commands(void);
uint32_t gfx_frame_vertices(void);
size_t gfx_frame_words(uint32_t surface);
#endif

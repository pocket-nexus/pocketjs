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
/* The app-switch transition alone on both screens, while no guest runs
 * (main.c's loading thread). False when the GPU still owns a frame. */
bool gfx_present_overlays(void);
uint32_t gfx_dropped_vertices(void);
/* A presented frame the GPU may still draw, or whose transfers wait for the
 * next present (qjs_complete_presentation finishes it). */
bool gfx_frame_in_flight(void);
uint32_t gfx_frame_commands(void);
uint32_t gfx_frame_vertices(void);
size_t gfx_frame_words(uint32_t surface);
#endif

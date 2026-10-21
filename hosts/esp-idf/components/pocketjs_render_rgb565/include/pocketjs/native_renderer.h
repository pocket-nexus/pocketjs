/* Generated from engine/runtime-cabi/src/compat/idf/render.rs. Do not edit. */
#pragma once
#include "pocketjs/render_rgb565.h"
int32_t pocketjs_native_render_target_create(pocketjs_rgb565_target_t * * output);
void pocketjs_native_render_target_destroy(pocketjs_rgb565_target_t * target);
void pocketjs_native_render_target_invalidate(pocketjs_rgb565_target_t * target);
void pocketjs_native_renderer_abort(pocketjs_rgb565_renderer_t * renderer, pocketjs_rgb565_target_t * target);
int32_t pocketjs_native_renderer_commit(pocketjs_rgb565_renderer_t * renderer, pocketjs_rgb565_target_t * target, const pocketjs_ui_frame_view_t * frame);
int32_t pocketjs_native_renderer_create(const pocketjs_rgb565_renderer_config_t * config, pocketjs_rgb565_renderer_t * * output);
void pocketjs_native_renderer_destroy(pocketjs_rgb565_renderer_t * renderer);
int32_t pocketjs_native_renderer_prepare(pocketjs_rgb565_renderer_t * renderer, pocketjs_rgb565_target_t * target, const pocketjs_ui_frame_view_t * frame, pocketjs_rgb565_damage_plan_t * output);
int32_t pocketjs_native_renderer_render_strip(pocketjs_rgb565_renderer_t * renderer, const pocketjs_ui_frame_view_t * frame, uint16_t * destination, size_t destination_pixels, pocketjs_rgb565_rect_t region, const pocketjs_rgb565_accelerator_t * accelerator, pocketjs_rgb565_render_stats_t * output);

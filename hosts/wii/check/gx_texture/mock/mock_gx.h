#ifndef POCKET_WII_GX_TEXTURE_MOCK_STATE_H
#define POCKET_WII_GX_TEXTURE_MOCK_STATE_H

#include <ogc/gx.h>

extern unsigned mock_gx_init_count;
extern unsigned mock_gx_lod_count;
extern unsigned mock_gx_draw_done_count;
extern unsigned mock_gx_invalidate_count;
extern unsigned mock_flush_count;
extern unsigned mock_free_count;
extern void *mock_flush_pointer;
extern u32 mock_flush_length;
extern void *mock_free_pointers[32];
extern unsigned mock_free_orders[32];
extern unsigned mock_event_order;
extern unsigned mock_last_draw_done_order;
extern unsigned mock_last_flush_order;
extern unsigned mock_last_invalidate_order;
extern unsigned mock_last_init_order;

#endif

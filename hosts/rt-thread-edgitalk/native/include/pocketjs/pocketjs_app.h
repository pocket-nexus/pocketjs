/*
 * Origin: PocketJS_for_Edgi-Talk/.../applications/pocketjs/include/pocketjs/pocketjs_app.h
 * Public entry: spawn host task + wait for first frame / init result.
 */
#pragma once

#include <rtthread.h>

rt_err_t pocketjs_app_start(void);
rt_err_t pocketjs_app_wait_ready(rt_int32_t timeout);

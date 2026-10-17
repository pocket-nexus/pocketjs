/* Origin: PocketJS_for_Edgi-Talk/.../applications/pocketjs/quickjs_compat.c
 * Minimal js_std_* for embedded QuickJS-ng without POSIX libc.
 */

#include <rtthread.h>

#include "quickjs-libc.h"

void js_std_init_handlers(JSRuntime *runtime)
{
    (void)runtime;
}

void js_std_add_helpers(JSContext *context, int argc, char **argv)
{
    (void)context;
    (void)argc;
    (void)argv;
}

void js_std_free_handlers(JSRuntime *runtime)
{
    (void)runtime;
}

void js_std_dump_error(JSContext *context)
{
    JSValue exception = JS_GetException(context);
    const char *text = JS_ToCString(context, exception);

    rt_kprintf("[PocketJS] JavaScript error: %s\n", text != RT_NULL ? text : "<unprintable>");

    if (text != RT_NULL)
    {
        JS_FreeCString(context, text);
    }
    JS_FreeValue(context, exception);
}

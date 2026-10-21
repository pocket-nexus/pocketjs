#ifndef POCKETJS_3DS_QJS_H
#define POCKETJS_3DS_QJS_H
#include "runtime.h"
/* One canonical Runtime; generated QuickJS Ui bindings share its state.
 * The caller retains the package until qjs_shutdown has completed. */
bool qjs_boot(PocketRuntimePackage *package);
bool qjs_frame(int32_t buttons,int32_t analog,const uint32_t *touches,size_t count,int32_t right_analog);
const char *qjs_last_error(void);
void qjs_shutdown(void);
#endif

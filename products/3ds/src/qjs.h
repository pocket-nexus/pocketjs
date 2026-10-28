#ifndef POCKETJS_3DS_QJS_H
#define POCKETJS_3DS_QJS_H
#include "runtime.h"
/* One canonical Runtime; generated QuickJS Ui bindings share its state.
 * The caller retains the package until qjs_shutdown has completed.
 *
 * qjs_boot admits the package and runs the bundle without presenting it;
 * the first qjs_frame presents the mounted tree and later ones advance it.
 * With `bytecode`, the bundle runs from that compiled form in place of the
 * package's source. Otherwise, with `compiled`, qjs_boot hands back the
 * bytecode it compiled (malloc'd, NULL when it could not be written) for
 * bytecode.c to keep for the next boot of the same package. */
bool qjs_boot(PocketRuntimePackage *package, const uint8_t *bytecode, size_t bytecode_length, uint8_t **compiled, size_t *compiled_length);
bool qjs_frame(int32_t buttons,int32_t analog,const uint32_t *touches,size_t count,int32_t right_analog);
/* The retained tree again, without running the guest: the leaving frames of
 * an app switch, drawn under the transition. */
bool qjs_present(void);
const char *qjs_last_error(void);
/* The last qjs_frame's two phases in microseconds: advance (input, the
 * guest's frame, the core step) and present (both screens' draw lists and
 * their submission, the native scene included). */
void qjs_frame_phases(uint32_t *advance_us, uint32_t *present_us);
void qjs_shutdown(void);
/* Called from QuickJS's interrupt handler while the guest's code runs (a
 * boot or a frame), every few thousand bytecode steps. Returning true ends
 * that code with an uncatchable error: the boot or the frame returns false
 * and qjs_interrupted is true until the next one starts. */
typedef bool (*QjsInterrupt)(void);
void qjs_set_interrupt(QjsInterrupt hook);
bool qjs_interrupted(void);
#endif

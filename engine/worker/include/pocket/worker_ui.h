#ifndef POCKET_WORKER_UI_H
#define POCKET_WORKER_UI_H
#include "pocket/worker.h"
#include "quickjs.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct pocket_worker_ui pocket_worker_ui;
/* The worker must finish bootstrap channel declaration before UI evaluation.
 * All bridge calls run on the UI context's owning task. The worker core and
 * its lock callbacks stay alive until after detach, including domain faults. */
pocket_worker_ui *pocket_worker_ui_attach(JSContext *, pocket_worker *);
/* Copy channel records, then advance __pocketWorkerChannelFrame before frame.
 * Snapshot mirrors persist without new publication; ring mirrors replace the
 * previous frame. A negative result leaves the JS exception on the context. */
int32_t pocket_worker_ui_latch(pocket_worker_ui *);
/* Invalidates retained host callbacks and removes only this bridge's namespace.
 * Call before destroying either the worker core or the UI context. */
void pocket_worker_ui_detach(pocket_worker_ui *);
#ifdef __cplusplus
}
#endif
#endif

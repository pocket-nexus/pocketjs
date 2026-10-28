/*
 * The 3DS side of engine/host-services/host_services.h: what main.c hands
 * the shared link and launcher.
 */

#ifndef POCKETJS_3DS_SERVICES_HOST_H
#define POCKETJS_3DS_SERVICES_HOST_H

#include "host_services.h"
#include "runtime.h"

/* The running slot's live runtime state, which runtime_slot_install keeps
 * current when a link install targets the running slot. */
void services_host_bind_runtime(PocketRuntimeState *state);

/* The launcher's view of a loaded package; borrows its bytes. */
LauncherPackage launcher_package(const PocketRuntimePackage *package);

#endif

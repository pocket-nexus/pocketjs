/* PocketJS MicroTS Hero launcher. The app does not fit the 512 KiB plugin
 * buffer, so this .rock loads pockethero.ovl into the top of the audio
 * buffer and runs it there. */

#include "plugin.h"
#include "lib/overlay.h"

enum plugin_status plugin_start(const void *parameter)
{
    return run_overlay(parameter, PLUGIN_APPS_DIR "/pockethero.ovl", "PocketJS Hero");
}

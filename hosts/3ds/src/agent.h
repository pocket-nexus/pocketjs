#ifndef POCKETJS_3DS_AGENT_H
#define POCKETJS_3DS_AGENT_H

/*
 * The system agent's host side (contracts/spec/agent.ts), for a guest that
 * declares "system.agent":
 *
 *   - the L+R chord: a shoulder's down edge waits AGENT_CHORD_FRAMES for the
 *     other; the chord's edges become host events and never reach the guest;
 *   - the microphone (MICU, PCM16 at 16360 Hz), streamed to the companion
 *     over the Pocket Link as data frames;
 *   - shots of the touch screen as RGB565, streamed the same way;
 *   - frames of the agent's own screen from the companion, shown on the
 *     stage's monitor without passing through the guest;
 *   - `globalThis.agent` (qjs.c): poll/send/stage/listen/level/shot/status.
 *
 * The link hands every ctrl message whose `t` starts with "agent." and every
 * data frame of an agent stream to agent_link_ctrl / agent_link_data.
 */

#include <citro3d.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* The running guest declared the capability. Turning it off stops the
 * microphone and drops undelivered events. */
void agent_set_enabled(bool enabled);
bool agent_enabled(void);
void agent_shutdown(void);

/* The guest's buttons this frame, with the chord's shoulders held back. */
int32_t agent_filter_buttons(int32_t buttons);
/* Once per frame: read the microphone and feed pending streams. */
void agent_pump(void);
/* Inside a frame, before drawing: take a requested shot of the touch screen
 * from its last frame. */
void agent_capture(C3D_RenderTarget *auxiliary);

/* From link.c. Return whether the message or bytes were the agent's. */
bool agent_link_ctrl(const char *json, size_t length);
bool agent_link_data(uint32_t stream, const uint8_t *bytes, size_t length);
void agent_link_changed(bool up);

/* `globalThis.agent`. Returned strings live until the next call. */
const char *agent_poll(void);
bool agent_send(const char *json, size_t length);
void agent_stage(int mode, int screen);
/* 1 starts (returns the stream id), 0 stops and sends, -1 stops and drops. */
int32_t agent_listen(int32_t command);
int32_t agent_level(void);
int32_t agent_shot(void);
const char *agent_status_json(void);

#endif

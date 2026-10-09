/*
 * Stub embed so hosts/rt-thread-edgitalk/native/SConscript links without a
 * product .pocket. Not a runnable package — regenerate real embed for firmware.
 */
#include "pocketjs_package_stub.h"

const pocketjs_embedded_package_t pocketjs_package_stub = {
    .data = 0,
    .size = 0U,
};

const pocketjs_package_host_contract_t pocketjs_package_stub_contract = {
    .struct_size = sizeof(pocketjs_package_stub_contract),
    .target_id = "edgitalk-m55",
    .host_abi = 1U,
    .tick_hz = 30U,
    .logical_width = 400U,
    .logical_height = 240U,
    .physical_width = 800U,
    .physical_height = 480U,
    .raster_density = 2U,
    .presentation = (pocketjs_presentation_t)3U,
    .profile_hash = {0},
};

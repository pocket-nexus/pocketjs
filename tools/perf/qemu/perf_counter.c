/*
 * PocketJS deterministic guest-work counter for QEMU linux-user.
 *
 * This plugin intentionally targets the QEMU 11.0.3 plugin API (version 6).
 * It counts guest events continuously in per-vCPU scoreboards and snapshots
 * one vCPU at matching BEGIN/END magic syscalls.
 *
 * SPDX-License-Identifier: MIT
 */

#include <glib.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include <qemu-plugin.h>

#define OUTPUT_PREFIX "POCKETJS_PERF_QEMU "
#define OUTPUT_SCHEMA "pocketjs.perf.qemu"
#define OUTPUT_VERSION 1
#define BUILT_FOR_QEMU "11.0.3"

#define MARKER_SYSCALL 4096
#define MARKER_MAGIC UINT64_C(0x504a424d)
#define MARKER_COOKIE UINT64_C(0xc001c0de)
#define MARKER_VERSION UINT64_C(1)
#define MARKER_OPCODE_BEGIN UINT64_C(1)
#define MARKER_OPCODE_END UINT64_C(2)
#define ARM_GETRANDOM_SYSCALL INT64_C(384)
#define AARCH64_GETRANDOM_SYSCALL INT64_C(278)

QEMU_PLUGIN_EXPORT int qemu_plugin_version = QEMU_PLUGIN_VERSION;

typedef struct {
    uint64_t guest_insn_dispatched;
    uint64_t guest_instruction_bytes;
    uint64_t guest_insn_size_2;
    uint64_t guest_insn_size_4;
    uint64_t guest_load_events;
    uint64_t guest_store_events;
} VcpuCounters;

typedef struct {
    bool active;
    bool failed;
    bool first_vcpu_seen;
    unsigned int active_vcpu;
    unsigned int first_vcpu;
    unsigned int vcpu_init_calls;
    uint32_t phase_id;
    uint32_t iteration;
    uint64_t measurement_count;
    const char *error_code;
    VcpuCounters begin;
} ProtocolState;

static struct qemu_plugin_scoreboard *counter_scoreboard;
static qemu_plugin_u64 insn_count;
static qemu_plugin_u64 instruction_bytes;
static qemu_plugin_u64 insn_size_2;
static qemu_plugin_u64 insn_size_4;
static qemu_plugin_u64 load_events;
static qemu_plugin_u64 store_events;

static GMutex state_lock;
static ProtocolState state;
static char *target_name;
static int64_t getrandom_syscall;

static void emit_line(const char *json)
{
    char *line = g_strdup_printf(OUTPUT_PREFIX "%s\n", json);
    qemu_plugin_outs(line);
    g_free(line);
}

static void emit_install_error(const char *code)
{
    char *json = g_strdup_printf(
        "{\"schema\":\"%s\",\"version\":%d,\"event\":\"error\","
        "\"plugin_api\":%d,\"qemu_version\":\"%s\",\"code\":\"%s\","
        "\"measurements\":0}",
        OUTPUT_SCHEMA, OUTPUT_VERSION, QEMU_PLUGIN_VERSION, BUILT_FOR_QEMU,
        code);
    emit_line(json);
    g_free(json);
}

static void fail_locked(const char *code)
{
    if (!state.failed) {
        state.failed = true;
        state.error_code = code;
    }
}

static VcpuCounters read_counters(unsigned int vcpu_index)
{
    VcpuCounters counters = {
        .guest_insn_dispatched = qemu_plugin_u64_get(insn_count, vcpu_index),
        .guest_instruction_bytes =
            qemu_plugin_u64_get(instruction_bytes, vcpu_index),
        .guest_insn_size_2 = qemu_plugin_u64_get(insn_size_2, vcpu_index),
        .guest_insn_size_4 = qemu_plugin_u64_get(insn_size_4, vcpu_index),
        .guest_load_events = qemu_plugin_u64_get(load_events, vcpu_index),
        .guest_store_events = qemu_plugin_u64_get(store_events, vcpu_index),
    };
    return counters;
}

static bool counters_are_monotonic(const VcpuCounters *end,
                                   const VcpuCounters *begin)
{
    return end->guest_insn_dispatched >= begin->guest_insn_dispatched &&
           end->guest_instruction_bytes >= begin->guest_instruction_bytes &&
           end->guest_insn_size_2 >= begin->guest_insn_size_2 &&
           end->guest_insn_size_4 >= begin->guest_insn_size_4 &&
           end->guest_load_events >= begin->guest_load_events &&
           end->guest_store_events >= begin->guest_store_events;
}

static VcpuCounters subtract_counters(const VcpuCounters *end,
                                      const VcpuCounters *begin)
{
    VcpuCounters delta = {
        .guest_insn_dispatched =
            end->guest_insn_dispatched - begin->guest_insn_dispatched,
        .guest_instruction_bytes =
            end->guest_instruction_bytes - begin->guest_instruction_bytes,
        .guest_insn_size_2 =
            end->guest_insn_size_2 - begin->guest_insn_size_2,
        .guest_insn_size_4 =
            end->guest_insn_size_4 - begin->guest_insn_size_4,
        .guest_load_events =
            end->guest_load_events - begin->guest_load_events,
        .guest_store_events =
            end->guest_store_events - begin->guest_store_events,
    };
    return delta;
}

static void emit_measurement(unsigned int vcpu_index, uint32_t phase_id,
                             uint32_t iteration,
                             const VcpuCounters *counters)
{
    char *json = g_strdup_printf(
        "{\"schema\":\"%s\",\"version\":%d,"
        "\"event\":\"measurement\",\"plugin_api\":%d,"
        "\"qemu_version\":\"%s\",\"target\":\"%s\","
        "\"vcpu\":%u,\"phase_id\":%" PRIu32 ","
        "\"iteration\":%" PRIu32 ",\"metrics\":{"
        "\"guest_insn_dispatched\":%" PRIu64 ","
        "\"guest_instruction_bytes\":%" PRIu64 ","
        "\"guest_insn_size_2\":%" PRIu64 ","
        "\"guest_insn_size_4\":%" PRIu64 ","
        "\"guest_load_events\":%" PRIu64 ","
        "\"guest_store_events\":%" PRIu64 "}}",
        OUTPUT_SCHEMA, OUTPUT_VERSION, QEMU_PLUGIN_VERSION, BUILT_FOR_QEMU,
        target_name, vcpu_index, phase_id, iteration,
        counters->guest_insn_dispatched,
        counters->guest_instruction_bytes,
        counters->guest_insn_size_2,
        counters->guest_insn_size_4,
        counters->guest_load_events,
        counters->guest_store_events);
    emit_line(json);
    g_free(json);
}

static void vcpu_init(qemu_plugin_id_t id, unsigned int vcpu_index)
{
    (void)id;

    g_mutex_lock(&state_lock);
    state.vcpu_init_calls++;
    if (!state.first_vcpu_seen) {
        state.first_vcpu_seen = true;
        state.first_vcpu = vcpu_index;
    } else {
        /* linux-user guest threads are separate vCPUs. They are unsupported. */
        fail_locked("multiple_vcpus");
    }
    g_mutex_unlock(&state_lock);
}

static void vcpu_tb_trans(qemu_plugin_id_t id, struct qemu_plugin_tb *tb)
{
    size_t count = qemu_plugin_tb_n_insns(tb);
    size_t i;

    (void)id;

    for (i = 0; i < count; i++) {
        struct qemu_plugin_insn *insn = qemu_plugin_tb_get_insn(tb, i);
        size_t size = qemu_plugin_insn_size(insn);

        qemu_plugin_register_vcpu_insn_exec_inline_per_vcpu(
            insn, QEMU_PLUGIN_INLINE_ADD_U64, insn_count, 1);
        qemu_plugin_register_vcpu_insn_exec_inline_per_vcpu(
            insn, QEMU_PLUGIN_INLINE_ADD_U64, instruction_bytes, size);

        if (size == 2) {
            qemu_plugin_register_vcpu_insn_exec_inline_per_vcpu(
                insn, QEMU_PLUGIN_INLINE_ADD_U64, insn_size_2, 1);
        } else if (size == 4) {
            qemu_plugin_register_vcpu_insn_exec_inline_per_vcpu(
                insn, QEMU_PLUGIN_INLINE_ADD_U64, insn_size_4, 1);
        }

        qemu_plugin_register_vcpu_mem_inline_per_vcpu(
            insn, QEMU_PLUGIN_MEM_R, QEMU_PLUGIN_INLINE_ADD_U64,
            load_events, 1);
        qemu_plugin_register_vcpu_mem_inline_per_vcpu(
            insn, QEMU_PLUGIN_MEM_W, QEMU_PLUGIN_INLINE_ADD_U64,
            store_events, 1);
    }
}

static bool marker_is_well_formed(uint64_t magic, uint64_t packed,
                                  uint64_t phase_id, uint64_t iteration,
                                  uint64_t cookie, uint64_t *opcode)
{
    uint64_t version;

    if (magic != MARKER_MAGIC) {
        fail_locked("invalid_marker_magic");
        return false;
    }
    if (cookie != MARKER_COOKIE) {
        fail_locked("invalid_marker_cookie");
        return false;
    }
    if ((packed & ~UINT64_C(0xffff)) != 0) {
        fail_locked("invalid_marker_reserved_bits");
        return false;
    }

    version = (packed >> 8) & UINT64_C(0xff);
    *opcode = packed & UINT64_C(0xff);
    if (version != MARKER_VERSION) {
        fail_locked("unsupported_marker_version");
        return false;
    }
    if (*opcode != MARKER_OPCODE_BEGIN && *opcode != MARKER_OPCODE_END) {
        fail_locked("invalid_marker_opcode");
        return false;
    }
    if (phase_id > UINT32_MAX || iteration > UINT32_MAX) {
        fail_locked("invalid_marker_argument_range");
        return false;
    }
    return true;
}

static bool vcpu_syscall_filter(qemu_plugin_id_t id,
                                unsigned int vcpu_index, int64_t number,
                                uint64_t a1, uint64_t a2, uint64_t a3,
                                uint64_t a4, uint64_t a5, uint64_t a6,
                                uint64_t a7, uint64_t a8, uint64_t *sysret)
{
    uint64_t opcode = 0;
    VcpuCounters end;
    VcpuCounters delta;
    uint32_t phase_id;
    uint32_t iteration;
    bool should_emit = false;

    (void)id;
    (void)a6;
    (void)a7;
    (void)a8;

    if (number == getrandom_syscall) {
        g_mutex_lock(&state_lock);
        if (state.active) {
            /* Entropy inside a phase makes repeated counter runs diverge. */
            fail_locked("getrandom_during_measurement");
        }
        g_mutex_unlock(&state_lock);
        return false;
    }

    if (number != MARKER_SYSCALL) {
        return false;
    }

    /* Never let the reserved benchmark syscall reach the host kernel. */
    *sysret = 0;

    g_mutex_lock(&state_lock);

    if (state.failed ||
        !marker_is_well_formed(a1, a2, a3, a4, a5, &opcode)) {
        g_mutex_unlock(&state_lock);
        return true;
    }

    if (state.vcpu_init_calls != 1 || qemu_plugin_num_vcpus() != 1) {
        fail_locked("multiple_vcpus");
        g_mutex_unlock(&state_lock);
        return true;
    }

    phase_id = (uint32_t)a3;
    iteration = (uint32_t)a4;

    if (opcode == MARKER_OPCODE_BEGIN) {
        if (state.active) {
            fail_locked("nested_begin");
        } else if (!state.first_vcpu_seen ||
                   state.first_vcpu != vcpu_index) {
            fail_locked("begin_vcpu_mismatch");
        } else {
            state.active = true;
            state.active_vcpu = vcpu_index;
            state.phase_id = phase_id;
            state.iteration = iteration;
            state.begin = read_counters(vcpu_index);
        }
        g_mutex_unlock(&state_lock);
        return true;
    }

    if (!state.active) {
        fail_locked("unexpected_end");
    } else if (state.active_vcpu != vcpu_index) {
        fail_locked("end_vcpu_mismatch");
    } else if (state.phase_id != phase_id || state.iteration != iteration) {
        fail_locked("marker_mismatch");
    } else {
        end = read_counters(vcpu_index);
        if (!counters_are_monotonic(&end, &state.begin)) {
            fail_locked("counter_overflow");
        } else {
            delta = subtract_counters(&end, &state.begin);
            state.active = false;
            state.measurement_count++;
            should_emit = true;
        }
    }

    g_mutex_unlock(&state_lock);

    if (should_emit) {
        emit_measurement(vcpu_index, phase_id, iteration, &delta);
    }
    return true;
}

static void plugin_exit(qemu_plugin_id_t id, void *userdata)
{
    const char *error_code = NULL;
    uint64_t measurements;
    char *json;

    (void)id;
    (void)userdata;

    g_mutex_lock(&state_lock);
    if (!state.failed && state.active) {
        fail_locked("missing_end");
    }
    if (!state.failed && state.measurement_count == 0) {
        fail_locked("missing_begin");
    }
    if (state.failed) {
        error_code = state.error_code;
    }
    measurements = state.measurement_count;
    g_mutex_unlock(&state_lock);

    if (error_code != NULL) {
        json = g_strdup_printf(
            "{\"schema\":\"%s\",\"version\":%d,\"event\":\"error\","
            "\"plugin_api\":%d,\"qemu_version\":\"%s\","
            "\"target\":\"%s\",\"code\":\"%s\","
            "\"measurements\":%" PRIu64 "}",
            OUTPUT_SCHEMA, OUTPUT_VERSION, QEMU_PLUGIN_VERSION,
            BUILT_FOR_QEMU, target_name, error_code, measurements);
    } else {
        json = g_strdup_printf(
            "{\"schema\":\"%s\",\"version\":%d,"
            "\"event\":\"complete\",\"plugin_api\":%d,"
            "\"qemu_version\":\"%s\",\"target\":\"%s\","
            "\"measurements\":%" PRIu64 "}",
            OUTPUT_SCHEMA, OUTPUT_VERSION, QEMU_PLUGIN_VERSION,
            BUILT_FOR_QEMU, target_name, measurements);
    }
    emit_line(json);
    g_free(json);

    qemu_plugin_scoreboard_free(counter_scoreboard);
    g_free(target_name);
    g_mutex_clear(&state_lock);
}

QEMU_PLUGIN_EXPORT int qemu_plugin_install(qemu_plugin_id_t id,
                                           const qemu_info_t *info,
                                           int argc, char **argv)
{
    (void)argv;

    if (QEMU_PLUGIN_VERSION != 6 || info->version.cur != 6 ||
        info->version.min > 6) {
        emit_install_error("plugin_api_mismatch");
        return -1;
    }
    if (info->system_emulation) {
        emit_install_error("linux_user_required");
        return -1;
    }
    if (strcmp(info->target_name, "arm") != 0 &&
        strcmp(info->target_name, "aarch64") != 0) {
        emit_install_error("unsupported_target");
        return -1;
    }
    if (argc != 0) {
        emit_install_error("unexpected_plugin_argument");
        return -1;
    }

    g_mutex_init(&state_lock);
    target_name = g_strdup(info->target_name);
    getrandom_syscall = strcmp(info->target_name, "arm") == 0
        ? ARM_GETRANDOM_SYSCALL
        : AARCH64_GETRANDOM_SYSCALL;
    counter_scoreboard = qemu_plugin_scoreboard_new(sizeof(VcpuCounters));
    insn_count = qemu_plugin_scoreboard_u64_in_struct(
        counter_scoreboard, VcpuCounters, guest_insn_dispatched);
    instruction_bytes = qemu_plugin_scoreboard_u64_in_struct(
        counter_scoreboard, VcpuCounters, guest_instruction_bytes);
    insn_size_2 = qemu_plugin_scoreboard_u64_in_struct(
        counter_scoreboard, VcpuCounters, guest_insn_size_2);
    insn_size_4 = qemu_plugin_scoreboard_u64_in_struct(
        counter_scoreboard, VcpuCounters, guest_insn_size_4);
    load_events = qemu_plugin_scoreboard_u64_in_struct(
        counter_scoreboard, VcpuCounters, guest_load_events);
    store_events = qemu_plugin_scoreboard_u64_in_struct(
        counter_scoreboard, VcpuCounters, guest_store_events);

    qemu_plugin_register_vcpu_init_cb(id, vcpu_init);
    qemu_plugin_register_vcpu_tb_trans_cb(id, vcpu_tb_trans);
    qemu_plugin_register_vcpu_syscall_filter_cb(id, vcpu_syscall_filter);
    qemu_plugin_register_atexit_cb(id, plugin_exit, NULL);
    return 0;
}

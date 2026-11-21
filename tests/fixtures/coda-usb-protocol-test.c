#define CODA_PROTOCOL_TEST 1
#include "../../tools/symbian/coda-usb-probe.c"

#include <assert.h>

static size_t frame_payload(
    const unsigned char *payload,
    size_t payload_length,
    unsigned char *frame,
    size_t capacity
) {
    assert(payload_length <= UINT16_MAX);
    assert(payload_length + 4 <= capacity);
    frame[0] = 0x01;
    frame[1] = 0x92;
    frame[2] = (unsigned char)(payload_length >> 8);
    frame[3] = (unsigned char)(payload_length & 0xff);
    memcpy(frame + 4, payload, payload_length);
    return payload_length + 4;
}

static struct command_reply_context fresh_reply(void) {
    const struct command_reply_context reply = {
        .token = "0",
        .type = '\0',
        .values_length = 0,
        .values_overflow = 0,
    };
    return reply;
}

int main(void) {
    static const unsigned char expected_command[] =
        "C\0"
        "0\0"
        "Processes\0"
        "start\0"
        "\"\"\0"
        "\"PocketJsE7Runtime.exe\"\0"
        "[]\0"
        "[]\0"
        "false\0";
    unsigned char command[CommandCapacity];
    size_t command_length = 0;
    assert(build_process_start_command(
        "PocketJsE7Runtime.exe",
        "0",
        command,
        sizeof(command),
        &command_length
    ));
    assert(command_length == 59);
    assert(command_length == sizeof(expected_command) - 1);
    assert(memcmp(command, expected_command, command_length) == 0);
    assert(valid_basename("PocketJsE7Runtime.exe", ".exe"));
    assert(!valid_basename("", ".exe"));
    assert(!valid_basename(".exe", ".exe"));
    assert(!valid_basename("../PocketJsE7Runtime.exe", ".exe"));
    assert(!valid_basename("PocketJsE7Runtime.sis", ".exe"));

    static const unsigned char expected_install[] =
        "C\0"
        "1\0"
        "SymbianInstall\0"
        "install\0"
        "\"E:\\\\Installs\\\\nexus-touch-e7-1.0.3.sis\"\0"
        "\"E:\"\0";
    assert(build_install_command(
        "nexus-touch-e7-1.0.3.sis",
        "1",
        command,
        sizeof(command),
        &command_length
    ));
    assert(command_length == sizeof(expected_install) - 1);
    assert(memcmp(command, expected_install, command_length) == 0);
    assert(valid_basename("nexus-touch-e7-1.0.3.sis", ".sis"));
    assert(!valid_basename("Installs\\clear-main.sis", ".sis"));
    assert(!valid_basename("clear-main.exe", ".sis"));

    static const unsigned char locator_payload[] =
        "E\0Locator\0Hello\0[\"Locator\",\"Processes\"]\0";
    unsigned char locator_frame[256];
    const size_t locator_length = frame_payload(
        locator_payload,
        sizeof(locator_payload) - 1,
        locator_frame,
        sizeof(locator_frame)
    );
    assert(find_locator_hello(locator_frame, (int)locator_length));
    assert(locator_advertises(
        locator_frame,
        (int)locator_length,
        "\"Processes\""
    ));
    assert(!locator_advertises(
        locator_frame,
        (int)locator_length,
        "\"SymbianInstall\""
    ));

    static const unsigned char success_payload[] =
        "R\0"
        "0\0"
        "{\"ID\":\"p2382\",\"CanTerminate\":true}\0";
    unsigned char success_frame[256];
    const size_t success_length = frame_payload(
        success_payload,
        sizeof(success_payload) - 1,
        success_frame,
        sizeof(success_frame)
    );
    struct command_reply_context reply = fresh_reply();
    assert(!match_command_reply(
        success_frame,
        (int)success_length - 1,
        &reply
    ));
    assert(match_command_reply(success_frame, (int)success_length, &reply));
    assert(reply.type == 'R');
    assert(!reply.values_overflow);
    assert(!command_reply_has_error(&reply));
    char process_id[32];
    assert(extract_process_id(&reply, process_id, sizeof(process_id)));
    assert(strcmp(process_id, "p2382") == 0);

    static const unsigned char event_payload[] =
        "E\0Locator\0peerHeartBeat\0\0";
    unsigned char coalesced[512];
    size_t coalesced_length = frame_payload(
        event_payload,
        sizeof(event_payload) - 1,
        coalesced,
        sizeof(coalesced)
    );
    memcpy(coalesced + coalesced_length, success_frame, success_length);
    coalesced_length += success_length;
    reply = fresh_reply();
    assert(match_command_reply(coalesced, (int)coalesced_length, &reply));
    assert(reply.type == 'R');

    static const unsigned char progress_payload[] = "P\0" "0\0" "null\0";
    unsigned char progress_then_reply[512];
    size_t progress_length = frame_payload(
        progress_payload,
        sizeof(progress_payload) - 1,
        progress_then_reply,
        sizeof(progress_then_reply)
    );
    memcpy(
        progress_then_reply + progress_length,
        success_frame,
        success_length
    );
    reply = fresh_reply();
    assert(match_command_reply(
        progress_then_reply,
        (int)(progress_length + success_length),
        &reply
    ));
    assert(reply.type == 'R');

    static const unsigned char nak_payload[] = "N\0" "0\0";
    unsigned char nak_frame[32];
    const size_t nak_length = frame_payload(
        nak_payload,
        sizeof(nak_payload) - 1,
        nak_frame,
        sizeof(nak_frame)
    );
    reply = fresh_reply();
    assert(match_command_reply(nak_frame, (int)nak_length, &reply));
    assert(reply.type == 'N');

    static const unsigned char error_payload[] =
        "R\0"
        "0\0"
        "{\"Time\":1,\"Code\":-6,\"Format\":\"Already exists\"}\0";
    unsigned char error_frame[256];
    const size_t error_length = frame_payload(
        error_payload,
        sizeof(error_payload) - 1,
        error_frame,
        sizeof(error_frame)
    );
    reply = fresh_reply();
    assert(match_command_reply(error_frame, (int)error_length, &reply));
    assert(command_reply_has_error(&reply));

    static const unsigned char invalid_id_payload[] =
        "R\0"
        "0\0"
        "{\"ID\":17}\0";
    unsigned char invalid_id_frame[64];
    const size_t invalid_id_length = frame_payload(
        invalid_id_payload,
        sizeof(invalid_id_payload) - 1,
        invalid_id_frame,
        sizeof(invalid_id_frame)
    );
    reply = fresh_reply();
    assert(match_command_reply(
        invalid_id_frame,
        (int)invalid_id_length,
        &reply
    ));
    assert(!extract_process_id(&reply, process_id, sizeof(process_id)));

    unsigned char overflow_payload[4 + 2049];
    memcpy(overflow_payload, "R\0" "0\0", 4);
    memset(overflow_payload + 4, 'x', sizeof(overflow_payload) - 4);
    unsigned char overflow_frame[sizeof(overflow_payload) + 4];
    const size_t overflow_length = frame_payload(
        overflow_payload,
        sizeof(overflow_payload),
        overflow_frame,
        sizeof(overflow_frame)
    );
    reply = fresh_reply();
    assert(match_command_reply(
        overflow_frame,
        (int)overflow_length,
        &reply
    ));
    assert(reply.values_overflow);

    return 0;
}

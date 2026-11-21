#define _POSIX_C_SOURCE 200809L

#ifndef CODA_PROTOCOL_TEST
#include <libusb.h>
#endif

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

enum {
    NokiaVendorId = 0x0421,
    NokiaE7SuiteProductId = 0x0335,
    CodaControlInterface = 3,
    CodaDataInterface = 4,
    TransferTimeoutMs = 3000,
    CommandTimeoutMs = 10000,
    /* A silent install unpacks, verifies and registers the whole package. */
    InstallTimeoutMs = 180000,
    TransferSliceMs = 250,
    ResponseCapacity = 16384,
    CommandCapacity = 512,
    MaxExecutableLength = 128,
};

#ifndef CODA_PROTOCOL_TEST
static int is_bulk_endpoint(
    const struct libusb_endpoint_descriptor *endpoint,
    int direction
) {
    return (endpoint->bmAttributes & LIBUSB_TRANSFER_TYPE_MASK) ==
            LIBUSB_TRANSFER_TYPE_BULK &&
        (endpoint->bEndpointAddress & LIBUSB_ENDPOINT_DIR_MASK) == direction;
}

static int find_coda_endpoints(
    libusb_device *device,
    uint8_t *endpoint_in,
    uint8_t *endpoint_out,
    int *alternate_setting
) {
    struct libusb_config_descriptor *config = NULL;
    int result = libusb_get_active_config_descriptor(device, &config);
    if (result != LIBUSB_SUCCESS)
        return result;

    for (uint8_t index = 0; index < config->bNumInterfaces; ++index) {
        const struct libusb_interface *interface = &config->interface[index];
        for (int alt = 0; alt < interface->num_altsetting; ++alt) {
            const struct libusb_interface_descriptor *descriptor =
                &interface->altsetting[alt];
            if (descriptor->bInterfaceNumber != CodaDataInterface)
                continue;
            uint8_t candidate_in = 0;
            uint8_t candidate_out = 0;
            for (uint8_t endpoint_index = 0;
                 endpoint_index < descriptor->bNumEndpoints;
                 ++endpoint_index) {
                const struct libusb_endpoint_descriptor *endpoint =
                    &descriptor->endpoint[endpoint_index];
                if (is_bulk_endpoint(endpoint, LIBUSB_ENDPOINT_IN))
                    candidate_in = endpoint->bEndpointAddress;
                else if (is_bulk_endpoint(endpoint, LIBUSB_ENDPOINT_OUT))
                    candidate_out = endpoint->bEndpointAddress;
            }
            if (candidate_in != 0 && candidate_out != 0) {
                *endpoint_in = candidate_in;
                *endpoint_out = candidate_out;
                *alternate_setting = descriptor->bAlternateSetting;
                libusb_free_config_descriptor(config);
                return LIBUSB_SUCCESS;
            }
        }
    }

    libusb_free_config_descriptor(config);
    return LIBUSB_ERROR_NOT_FOUND;
}

static int claim_interface(
    libusb_device_handle *handle,
    int interface,
    int *detached
) {
    *detached = 0;
    const int active = libusb_kernel_driver_active(handle, interface);
    if (active == 1) {
        const int detach_result =
            libusb_detach_kernel_driver(handle, interface);
        if (detach_result == LIBUSB_SUCCESS) {
            *detached = 1;
        } else if (detach_result != LIBUSB_ERROR_NOT_SUPPORTED) {
            return detach_result;
        }
    }
    const int result = libusb_claim_interface(handle, interface);
    if (result != LIBUSB_SUCCESS && *detached) {
        libusb_attach_kernel_driver(handle, interface);
        *detached = 0;
    }
    return result;
}

static int set_cdc_control_state(libusb_device_handle *handle) {
    static const unsigned char line_coding[] = {
        0x00, 0xc2, 0x01, 0x00, /* 115200, little endian */
        0x00,                   /* one stop bit */
        0x00,                   /* no parity */
        0x08,                   /* eight data bits */
    };
    int result = libusb_control_transfer(
        handle,
        LIBUSB_ENDPOINT_OUT | LIBUSB_REQUEST_TYPE_CLASS |
            LIBUSB_RECIPIENT_INTERFACE,
        0x20, /* SET_LINE_CODING */
        0,
        CodaControlInterface,
        (unsigned char *)line_coding,
        sizeof(line_coding),
        TransferTimeoutMs
    );
    if (result < 0 && result != LIBUSB_ERROR_PIPE)
        return result;

    result = libusb_control_transfer(
        handle,
        LIBUSB_ENDPOINT_OUT | LIBUSB_REQUEST_TYPE_CLASS |
            LIBUSB_RECIPIENT_INTERFACE,
        0x22, /* SET_CONTROL_LINE_STATE */
        0x0003,
        CodaControlInterface,
        NULL,
        0,
        TransferTimeoutMs
    );
    return result < 0 && result != LIBUSB_ERROR_PIPE
        ? result
        : LIBUSB_SUCCESS;
}
#endif

static int find_pong(
    const unsigned char *buffer,
    int length,
    char *version,
    size_t version_capacity
) {
    for (int offset = 0; offset + 6 <= length; ++offset) {
        if (buffer[offset] != 0x01 || buffer[offset + 1] != 0x92)
            continue;
        const int payload_length =
            ((int)buffer[offset + 2] << 8) | buffer[offset + 3];
        if (payload_length < 2 || offset + 4 + payload_length > length)
            continue;
        const unsigned char *payload = buffer + offset + 4;
        if (payload[0] != 0xfc || payload[1] != 0xf1)
            continue;
        const int available = payload_length - 2;
        const size_t copy_length = available < (int)version_capacity - 1
            ? (size_t)available
            : version_capacity - 1;
        size_t written = 0;
        for (size_t index = 0; index < copy_length; ++index) {
            const unsigned char value = payload[index + 2];
            if (value >= 0x20 && value <= 0x7e)
                version[written++] = (char)value;
        }
        version[written] = '\0';
        return 1;
    }
    return 0;
}

static int find_locator_hello(const unsigned char *buffer, int length) {
    static const unsigned char locator_prefix[] = {
        'E', 0x00,
        'L', 'o', 'c', 'a', 't', 'o', 'r', 0x00,
        'H', 'e', 'l', 'l', 'o', 0x00,
    };
    for (int offset = 0; offset + 4 + (int)sizeof(locator_prefix) <= length;
         ++offset) {
        if (buffer[offset] != 0x01 || buffer[offset + 1] != 0x92)
            continue;
        const int payload_length =
            ((int)buffer[offset + 2] << 8) | buffer[offset + 3];
        if (payload_length < (int)sizeof(locator_prefix) ||
            offset + 4 + payload_length > length) {
            continue;
        }
        if (memcmp(
                buffer + offset + 4,
                locator_prefix,
                sizeof(locator_prefix)
            ) == 0) {
            return 1;
        }
    }
    return 0;
}

static int bytes_contain(
    const unsigned char *buffer,
    int length,
    const char *needle
) {
    const size_t needle_length = strlen(needle);
    if (needle_length == 0 || needle_length > (size_t)length)
        return 0;
    for (int offset = 0;
         offset + (int)needle_length <= length;
         ++offset) {
        if (memcmp(buffer + offset, needle, needle_length) == 0)
            return 1;
    }
    return 0;
}

/* Whether the Locator Hello in `buffer` lists `service` (a quoted name). */
static int locator_advertises(
    const unsigned char *buffer,
    int length,
    const char *service
) {
    static const unsigned char locator_prefix[] = {
        'E', 0x00,
        'L', 'o', 'c', 'a', 't', 'o', 'r', 0x00,
        'H', 'e', 'l', 'l', 'o', 0x00,
    };
    for (int offset = 0; offset + 4 + (int)sizeof(locator_prefix) <= length;
         ++offset) {
        if (buffer[offset] != 0x01 || buffer[offset + 1] != 0x92)
            continue;
        const int payload_length =
            ((int)buffer[offset + 2] << 8) | buffer[offset + 3];
        if (payload_length < (int)sizeof(locator_prefix) ||
            offset + 4 + payload_length > length) {
            continue;
        }
        const unsigned char *payload = buffer + offset + 4;
        if (memcmp(payload, locator_prefix, sizeof(locator_prefix)) != 0)
            continue;
        return bytes_contain(payload, payload_length, service);
    }
    return 0;
}

typedef int (*response_matcher)(
    const unsigned char *buffer,
    int length,
    void *context
);

struct pong_context {
    char *version;
    size_t version_capacity;
};

static int match_pong(
    const unsigned char *buffer,
    int length,
    void *context
) {
    struct pong_context *pong = context;
    return find_pong(
        buffer,
        length,
        pong->version,
        pong->version_capacity
    );
}

static int match_locator(
    const unsigned char *buffer,
    int length,
    void *context
) {
    (void)context;
    return find_locator_hello(buffer, length);
}

/*
 * USB bulk reads are a byte stream: one router frame may be fragmented across
 * transfers, and several frames may arrive together. Keep a bounded
 * accumulator and match complete frames against a single total timeout.
 */
#ifndef CODA_PROTOCOL_TEST
static int read_until(
    libusb_device_handle *handle,
    uint8_t endpoint,
    unsigned char *buffer,
    int capacity,
    int *length,
    response_matcher matcher,
    void *context,
    int timeout_ms
) {
    if (matcher(buffer, *length, context))
        return LIBUSB_SUCCESS;

    struct timespec started;
    if (clock_gettime(CLOCK_MONOTONIC, &started) != 0)
        return LIBUSB_ERROR_OTHER;
    const int64_t deadline_ms =
        (int64_t)started.tv_sec * 1000 +
        started.tv_nsec / 1000000 +
        timeout_ms;
    while (1) {
        if (*length >= capacity)
            return LIBUSB_ERROR_OVERFLOW;

        struct timespec now;
        if (clock_gettime(CLOCK_MONOTONIC, &now) != 0)
            return LIBUSB_ERROR_OTHER;
        const int64_t now_ms =
            (int64_t)now.tv_sec * 1000 +
            now.tv_nsec / 1000000;
        const int64_t remaining_ms = deadline_ms - now_ms;
        if (remaining_ms <= 0)
            break;
        const int timeout = remaining_ms < TransferSliceMs
            ? (int)remaining_ms
            : TransferSliceMs;
        int transferred = 0;
        const int result = libusb_bulk_transfer(
            handle,
            endpoint,
            buffer + *length,
            capacity - *length,
            &transferred,
            (unsigned int)timeout
        );
        if (transferred > 0) {
            *length += transferred;
            if (matcher(buffer, *length, context))
                return LIBUSB_SUCCESS;
        }
        if (result != LIBUSB_SUCCESS && result != LIBUSB_ERROR_TIMEOUT)
            return result;
    }
    return LIBUSB_ERROR_TIMEOUT;
}
#endif

struct command_reply_context {
    const char *token;
    char type;
    unsigned char values[2048];
    int values_length;
    int values_overflow;
};

static int match_command_reply(
    const unsigned char *buffer,
    int length,
    void *context
) {
    struct command_reply_context *reply = context;
    const size_t token_length = strlen(reply->token);
    for (int offset = 0; offset + 4 <= length; ++offset) {
        if (buffer[offset] != 0x01 || buffer[offset + 1] != 0x92)
            continue;
        const int payload_length =
            ((int)buffer[offset + 2] << 8) | buffer[offset + 3];
        if (payload_length < 4 ||
            offset + 4 + payload_length > length) {
            continue;
        }
        const unsigned char *payload = buffer + offset + 4;
        if ((payload[0] != 'R' && payload[0] != 'N') ||
            payload[1] != '\0') {
            continue;
        }
        if (2 + token_length >= (size_t)payload_length ||
            memcmp(payload + 2, reply->token, token_length) != 0 ||
            payload[2 + token_length] != '\0') {
            continue;
        }
        reply->type = (char)payload[0];
        const int values_offset = 3 + (int)token_length;
        const int available = payload_length - values_offset;
        reply->values_overflow = available > (int)sizeof(reply->values);
        reply->values_length = available < (int)sizeof(reply->values)
            ? available
            : (int)sizeof(reply->values);
        if (reply->values_length > 0) {
            memcpy(
                reply->values,
                payload + values_offset,
                (size_t)reply->values_length
            );
        }
        return 1;
    }
    return 0;
}

static int append_command_field(
    unsigned char *command,
    size_t capacity,
    size_t *length,
    const char *field
) {
    const size_t field_length = strlen(field);
    if (*length + field_length + 1 > capacity)
        return 0;
    memcpy(command + *length, field, field_length);
    *length += field_length;
    command[(*length)++] = '\0';
    return 1;
}

/* A bare file name ending in `suffix` (".exe", ".sis"): no separators, so it
 * cannot name a file outside the directory the command addresses. */
static int valid_basename(const char *name, const char *suffix) {
    const size_t length = strlen(name);
    const size_t suffix_length = strlen(suffix);
    if (length <= suffix_length || length > MaxExecutableLength ||
        strcmp(name + length - suffix_length, suffix) != 0) {
        return 0;
    }
    for (size_t index = 0; index < length; ++index) {
        const char value = name[index];
        if ((value >= 'a' && value <= 'z') ||
            (value >= 'A' && value <= 'Z') ||
            (value >= '0' && value <= '9') ||
            value == '.' || value == '_' || value == '-') {
            continue;
        }
        return 0;
    }
    return 1;
}

/* SymbianInstall.install: the package's device path and the target drive,
 * each a JSON string (the command Qt Creator's CODA deploy step sends). */
static int build_install_command(
    const char *file,
    const char *token,
    unsigned char *command,
    size_t command_capacity,
    size_t *command_length
) {
    char quoted_path[MaxExecutableLength + 32];
    const int quoted_length = snprintf(
        quoted_path,
        sizeof(quoted_path),
        "\"E:\\\\Installs\\\\%s\"",
        file
    );
    if (quoted_length < 0 || quoted_length >= (int)sizeof(quoted_path))
        return 0;
    *command_length = 0;
    const char *fields[] = {
        "C",
        token,
        "SymbianInstall",
        "install",
        quoted_path,
        "\"E:\"",
    };
    for (size_t index = 0;
         index < sizeof(fields) / sizeof(fields[0]);
         ++index) {
        if (!append_command_field(
                command,
                command_capacity,
                command_length,
                fields[index]
            )) {
            return 0;
        }
    }
    return 1;
}

static int build_process_start_command(
    const char *executable,
    const char *token,
    unsigned char *command,
    size_t command_capacity,
    size_t *command_length
) {
    char quoted_executable[MaxExecutableLength + 3];
    const int quoted_length = snprintf(
        quoted_executable,
        sizeof(quoted_executable),
        "\"%s\"",
        executable
    );
    if (quoted_length < 0 ||
        quoted_length >= (int)sizeof(quoted_executable)) {
        return 0;
    }

    *command_length = 0;
    const char *fields[] = {
        "C",
        token,
        "Processes",
        "start",
        "\"\"",
        quoted_executable,
        "[]",
        "[]",
        "false",
    };
    for (size_t index = 0;
         index < sizeof(fields) / sizeof(fields[0]);
         ++index) {
        if (!append_command_field(
                command,
                command_capacity,
                command_length,
                fields[index]
            )) {
            return 0;
        }
    }
    return 1;
}

#ifndef CODA_PROTOCOL_TEST
static int send_serial_payload(
    libusb_device_handle *handle,
    uint8_t endpoint,
    const unsigned char *payload,
    size_t payload_length
) {
    if (payload_length > UINT16_MAX)
        return LIBUSB_ERROR_INVALID_PARAM;
    unsigned char *frame = malloc(payload_length + 4);
    if (frame == NULL)
        return LIBUSB_ERROR_NO_MEM;
    frame[0] = 0x01;
    frame[1] = 0x92;
    frame[2] = (unsigned char)(payload_length >> 8);
    frame[3] = (unsigned char)(payload_length & 0xff);
    memcpy(frame + 4, payload, payload_length);

    int transferred = 0;
    const int result = libusb_bulk_transfer(
        handle,
        endpoint,
        frame,
        (int)payload_length + 4,
        &transferred,
        TransferTimeoutMs
    );
    free(frame);
    return result == LIBUSB_SUCCESS &&
            transferred != (int)payload_length + 4
        ? LIBUSB_ERROR_IO
        : result;
}
#endif

static int command_reply_has_error(
    const struct command_reply_context *reply
) {
    static const char *error_keys[] = {
        "\"Time\"", "\"Code\"", "\"Format\"", "\"AltCode\"", "\"AltOrg\"",
    };
    int matches = 0;
    for (size_t index = 0;
         index < sizeof(error_keys) / sizeof(error_keys[0]);
         ++index) {
        if (bytes_contain(
                reply->values,
                reply->values_length,
                error_keys[index]
            )) {
            ++matches;
        }
    }
    return matches >= 2;
}

static int extract_process_id(
    const struct command_reply_context *reply,
    char *process_id,
    size_t capacity
) {
    static const char key[] = "\"ID\"";
    for (int offset = 0;
         offset + (int)sizeof(key) - 1 < reply->values_length;
         ++offset) {
        if (memcmp(reply->values + offset, key, sizeof(key) - 1) != 0)
            continue;
        int cursor = offset + (int)sizeof(key) - 1;
        while (cursor < reply->values_length &&
               (reply->values[cursor] == ' ' ||
                reply->values[cursor] == ':')) {
            ++cursor;
        }
        if (cursor >= reply->values_length ||
            reply->values[cursor] != '"') {
            continue;
        }
        ++cursor;
        size_t written = 0;
        while (cursor < reply->values_length &&
               reply->values[cursor] != '"' &&
               written + 1 < capacity) {
            const unsigned char value = reply->values[cursor++];
            if (value < 0x20 || value > 0x7e)
                return 0;
            process_id[written++] = (char)value;
        }
        if (cursor >= reply->values_length ||
            reply->values[cursor] != '"' ||
            written == 0) {
            return 0;
        }
        process_id[written] = '\0';
        return 1;
    }
    return 0;
}

static void print_command_error(
    const char *label,
    const char *rejection,
    const struct command_reply_context *reply
) {
    fprintf(stderr, "%s: %s", label, rejection);
    if (reply->values_length > 0) {
        fprintf(stderr, " (");
        for (int index = 0; index < reply->values_length; ++index) {
            const unsigned char value = reply->values[index];
            if (value == '\0')
                fputs(" | ", stderr);
            else if (value >= 0x20 && value <= 0x7e)
                fputc((int)value, stderr);
        }
        fprintf(stderr, ")");
    }
    fprintf(stderr, "\n");
}

#ifndef CODA_PROTOCOL_TEST
/* Send one command and read its reply. A NAK or an error reply prints
 * `label: rejection` with the reply's values and returns ERROR_OTHER. */
static int run_command(
    libusb_device_handle *handle,
    uint8_t endpoint_in,
    uint8_t endpoint_out,
    unsigned char *response,
    int response_capacity,
    int *response_length,
    const unsigned char *command,
    size_t command_length,
    struct command_reply_context *reply,
    int timeout_ms,
    const char *label,
    const char *rejection
) {
    int result = send_serial_payload(
        handle,
        endpoint_out,
        command,
        command_length
    );
    if (result != LIBUSB_SUCCESS)
        return result;

    result = read_until(
        handle,
        endpoint_in,
        response,
        response_capacity,
        response_length,
        match_command_reply,
        reply,
        timeout_ms
    );
    if (result != LIBUSB_SUCCESS)
        return result;
    if (reply->values_overflow) {
        fprintf(stderr, "%s: reply exceeds the safe parser limit\n", label);
        return LIBUSB_ERROR_OVERFLOW;
    }
    if (reply->type != 'R' || command_reply_has_error(reply)) {
        print_command_error(label, rejection, reply);
        return LIBUSB_ERROR_OTHER;
    }
    return LIBUSB_SUCCESS;
}

static int launch_process(
    libusb_device_handle *handle,
    uint8_t endpoint_in,
    uint8_t endpoint_out,
    unsigned char *response,
    int response_capacity,
    int *response_length,
    const char *executable
) {
    static const char token[] = "0";
    unsigned char command[CommandCapacity];
    size_t command_length = 0;
    if (!build_process_start_command(
            executable,
            token,
            command,
            sizeof(command),
            &command_length
        )) {
        return LIBUSB_ERROR_OVERFLOW;
    }

    struct command_reply_context reply = {
        .token = token,
        .type = '\0',
        .values_length = 0,
        .values_overflow = 0,
    };
    const int result = run_command(
        handle,
        endpoint_in,
        endpoint_out,
        response,
        response_capacity,
        response_length,
        command,
        command_length,
        &reply,
        CommandTimeoutMs,
        "CODA launch",
        "device rejected the start command"
    );
    if (result != LIBUSB_SUCCESS)
        return result;

    char process_id[128];
    if (!extract_process_id(&reply, process_id, sizeof(process_id))) {
        fprintf(stderr, "CODA launch: success reply has no process ID\n");
        return LIBUSB_ERROR_OTHER;
    }
    printf("CODA launch: started\n");
    printf("CODA executable: %s\n", executable);
    printf("CODA process: %s\n", process_id);
    return LIBUSB_SUCCESS;
}

static int install_package(
    libusb_device_handle *handle,
    uint8_t endpoint_in,
    uint8_t endpoint_out,
    unsigned char *response,
    int response_capacity,
    int *response_length,
    const char *file
) {
    static const char token[] = "1";
    unsigned char command[CommandCapacity];
    size_t command_length = 0;
    if (!build_install_command(
            file,
            token,
            command,
            sizeof(command),
            &command_length
        )) {
        return LIBUSB_ERROR_OVERFLOW;
    }

    struct command_reply_context reply = {
        .token = token,
        .type = '\0',
        .values_length = 0,
        .values_overflow = 0,
    };
    const int result = run_command(
        handle,
        endpoint_in,
        endpoint_out,
        response,
        response_capacity,
        response_length,
        command,
        command_length,
        &reply,
        InstallTimeoutMs,
        "CODA install",
        "device rejected the package"
    );
    if (result != LIBUSB_SUCCESS)
        return result;
    printf("CODA install: installed E:\\Installs\\%s\n", file);
    return LIBUSB_SUCCESS;
}

int main(int argc, char **argv) {
    const char *executable = NULL;
    const char *package = NULL;
    if (argc == 3 && strcmp(argv[1], "launch") == 0) {
        executable = argv[2];
        if (!valid_basename(executable, ".exe")) {
            fprintf(
                stderr,
                "CODA USB: executable must be a basename ending in .exe\n"
            );
            return 2;
        }
    } else if (argc == 3 && strcmp(argv[1], "install") == 0) {
        package = argv[2];
        if (!valid_basename(package, ".sis")) {
            fprintf(stderr, "CODA USB: package must be a basename ending in .sis\n");
            return 2;
        }
    } else if (argc != 1) {
        fprintf(stderr, "usage: coda-usb-probe [launch <executable.exe> | install <package.sis>]\n");
        return 2;
    }

    libusb_context *context = NULL;
    libusb_device **devices = NULL;
    libusb_device *match = NULL;
    libusb_device_handle *handle = NULL;
    uint8_t endpoint_in = 0;
    uint8_t endpoint_out = 0;
    int alternate_setting = 0;
    int control_claimed = 0;
    int data_claimed = 0;
    int control_detached = 0;
    int data_detached = 0;
    int exit_code = 1;

    int result = libusb_init(&context);
    if (result != LIBUSB_SUCCESS) {
        fprintf(stderr, "CODA USB: libusb initialization failed\n");
        return 1;
    }

    const ssize_t count = libusb_get_device_list(context, &devices);
    if (count < 0) {
        fprintf(stderr, "CODA USB: device enumeration failed\n");
        goto cleanup;
    }

    int matches = 0;
    for (ssize_t index = 0; index < count; ++index) {
        struct libusb_device_descriptor descriptor;
        if (libusb_get_device_descriptor(devices[index], &descriptor) !=
            LIBUSB_SUCCESS) {
            continue;
        }
        if (descriptor.idVendor == NokiaVendorId &&
            descriptor.idProduct == NokiaE7SuiteProductId) {
            match = devices[index];
            ++matches;
        }
    }
    if (matches != 1) {
        fprintf(
            stderr,
            "CODA USB: expected exactly one Nokia E7 in Suite mode, found %d\n",
            matches
        );
        goto cleanup;
    }

    result = find_coda_endpoints(
        match,
        &endpoint_in,
        &endpoint_out,
        &alternate_setting
    );
    if (result != LIBUSB_SUCCESS) {
        fprintf(stderr, "CODA USB: interface 4 bulk endpoints are unavailable\n");
        goto cleanup;
    }

    result = libusb_open(match, &handle);
    if (result != LIBUSB_SUCCESS) {
        fprintf(stderr, "CODA USB: unable to open the E7 USB device\n");
        goto cleanup;
    }

    result = claim_interface(
        handle,
        CodaControlInterface,
        &control_detached
    );
    if (result == LIBUSB_SUCCESS)
        control_claimed = 1;
    else if (result != LIBUSB_ERROR_BUSY &&
             result != LIBUSB_ERROR_NOT_SUPPORTED) {
        fprintf(stderr, "CODA USB: unable to claim control interface 3\n");
        goto cleanup;
    }

    result = claim_interface(handle, CodaDataInterface, &data_detached);
    if (result != LIBUSB_SUCCESS) {
        fprintf(
            stderr,
            "CODA USB: unable to claim data interface 4 (%s)\n",
            libusb_error_name(result)
        );
        goto cleanup;
    }
    data_claimed = 1;

    if (alternate_setting != 0) {
        result = libusb_set_interface_alt_setting(
            handle,
            CodaDataInterface,
            alternate_setting
        );
        if (result != LIBUSB_SUCCESS) {
            fprintf(stderr, "CODA USB: unable to select the data interface\n");
            goto cleanup;
        }
    }

    if (control_claimed) {
        result = set_cdc_control_state(handle);
        if (result != LIBUSB_SUCCESS) {
            fprintf(stderr, "CODA USB: unable to initialize the control channel\n");
            goto cleanup;
        }
    }

    static const unsigned char ping[] = {
        0x01, 0x92, 0x00, 0x02, 0xfc, 0x1f,
    };
    int transferred = 0;
    result = libusb_bulk_transfer(
        handle,
        endpoint_out,
        (unsigned char *)ping,
        sizeof(ping),
        &transferred,
        TransferTimeoutMs
    );
    if (result != LIBUSB_SUCCESS || transferred != (int)sizeof(ping)) {
        fprintf(stderr, "CODA USB: ping write failed\n");
        goto cleanup;
    }

    unsigned char response[ResponseCapacity];
    int response_length = 0;
    char version[256];
    struct pong_context pong = {
        .version = version,
        .version_capacity = sizeof(version),
    };
    result = read_until(
        handle,
        endpoint_in,
        response,
        sizeof(response),
        &response_length,
        match_pong,
        &pong,
        TransferTimeoutMs
    );
    if (result != LIBUSB_SUCCESS) {
        fprintf(
            stderr,
            "CODA USB: no pong received (%s)\n",
            libusb_error_name(result)
        );
        goto cleanup;
    }

    static const unsigned char locator_answer[] =
        "E\0Locator\0Hello\0[\"Locator\"]";
    const size_t locator_length = sizeof(locator_answer);
    unsigned char locator_frame[4 + sizeof(locator_answer)];
    locator_frame[0] = 0x01;
    locator_frame[1] = 0x92;
    locator_frame[2] = (unsigned char)(locator_length >> 8);
    locator_frame[3] = (unsigned char)(locator_length & 0xff);
    memcpy(locator_frame + 4, locator_answer, locator_length);

    transferred = 0;
    result = libusb_bulk_transfer(
        handle,
        endpoint_out,
        locator_frame,
        sizeof(locator_frame),
        &transferred,
        TransferTimeoutMs
    );
    if (result != LIBUSB_SUCCESS ||
        transferred != (int)sizeof(locator_frame)) {
        fprintf(stderr, "CODA USB: Locator hello write failed\n");
        goto cleanup;
    }

    result = read_until(
        handle,
        endpoint_in,
        response,
        sizeof(response),
        &response_length,
        match_locator,
        NULL,
        TransferTimeoutMs
    );
    if (result != LIBUSB_SUCCESS) {
        fprintf(stderr, "CODA USB: Locator handshake failed\n");
        goto cleanup;
    }

    printf("CODA USB: ready\n");
    if (version[0] != '\0')
        printf("CODA version: %s\n", version);
    printf("CODA Locator: ready\n");

    if (package != NULL) {
        if (!locator_advertises(response, response_length, "\"SymbianInstall\"")) {
            fprintf(stderr, "CODA install: SymbianInstall service is unavailable\n");
            goto cleanup;
        }
        result = install_package(
            handle,
            endpoint_in,
            endpoint_out,
            response,
            sizeof(response),
            &response_length,
            package
        );
        if (result != LIBUSB_SUCCESS) {
            if (result != LIBUSB_ERROR_OTHER) {
                fprintf(stderr, "CODA install: failed (%s)\n", libusb_error_name(result));
            }
            goto cleanup;
        }
    }
    if (executable != NULL) {
        if (!locator_advertises(response, response_length, "\"Processes\"")) {
            fprintf(stderr, "CODA launch: Processes service is unavailable\n");
            goto cleanup;
        }
        result = launch_process(
            handle,
            endpoint_in,
            endpoint_out,
            response,
            sizeof(response),
            &response_length,
            executable
        );
        if (result != LIBUSB_SUCCESS) {
            if (result != LIBUSB_ERROR_OTHER) {
                fprintf(
                    stderr,
                    "CODA launch: failed (%s)\n",
                    libusb_error_name(result)
                );
            }
            goto cleanup;
        }
    }
    exit_code = 0;

cleanup:
    if (data_claimed)
        libusb_release_interface(handle, CodaDataInterface);
    if (control_claimed)
        libusb_release_interface(handle, CodaControlInterface);
    if (data_detached)
        libusb_attach_kernel_driver(handle, CodaDataInterface);
    if (control_detached)
        libusb_attach_kernel_driver(handle, CodaControlInterface);
    if (handle != NULL)
        libusb_close(handle);
    if (devices != NULL)
        libusb_free_device_list(devices, 1);
    libusb_exit(context);
    return exit_code;
}
#endif

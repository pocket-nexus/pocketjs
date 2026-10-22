#define _DARWIN_C_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <libusb.h>
#include <poll.h>
#if defined(__APPLE__)
#include <util.h>
#else
#include <pty.h>
#endif
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

enum {
    MeizuVendorId = 0x0547,
    MeizuM8SeSerialProductId = 0x2720,
    MeizuSerialInterface = 0,
    MeizuSerialEndpointIn = 0x81,
    MeizuSerialEndpointOut = 0x02,
    TransferSliceMs = 50,
    ProbeTimeoutMs = 5000,
    TransferCapacity = 16384,
};

static volatile sig_atomic_t stopped;
static volatile sig_atomic_t reset_requested;

static void stop_bridge(int signal_number) {
    (void)signal_number;
    stopped = 1;
}

static void request_reset(int signal_number) {
    (void)signal_number;
    reset_requested = 1;
}

static int is_bulk_endpoint(
    const struct libusb_endpoint_descriptor *endpoint,
    int direction
) {
    return (endpoint->bmAttributes & LIBUSB_TRANSFER_TYPE_MASK) ==
            LIBUSB_TRANSFER_TYPE_BULK &&
        (endpoint->bEndpointAddress & LIBUSB_ENDPOINT_DIR_MASK) == direction;
}

static int verify_descriptor(libusb_device *device) {
    struct libusb_config_descriptor *config = NULL;
    int result = libusb_get_active_config_descriptor(device, &config);
    if (result != LIBUSB_SUCCESS)
        return result;

    int matched = 0;
    if (config->bNumInterfaces == 1) {
        const struct libusb_interface *interface = &config->interface[0];
        for (int index = 0; index < interface->num_altsetting; ++index) {
            const struct libusb_interface_descriptor *descriptor =
                &interface->altsetting[index];
            if (descriptor->bInterfaceNumber != MeizuSerialInterface ||
                descriptor->bInterfaceClass != LIBUSB_CLASS_VENDOR_SPEC ||
                descriptor->bNumEndpoints != 2) {
                continue;
            }
            int found_in = 0;
            int found_out = 0;
            for (uint8_t endpoint_index = 0;
                 endpoint_index < descriptor->bNumEndpoints;
                 ++endpoint_index) {
                const struct libusb_endpoint_descriptor *endpoint =
                    &descriptor->endpoint[endpoint_index];
                if (endpoint->bEndpointAddress == MeizuSerialEndpointIn &&
                    is_bulk_endpoint(endpoint, LIBUSB_ENDPOINT_IN) &&
                    endpoint->wMaxPacketSize == 512) {
                    found_in = 1;
                } else if (
                    endpoint->bEndpointAddress == MeizuSerialEndpointOut &&
                    is_bulk_endpoint(endpoint, LIBUSB_ENDPOINT_OUT) &&
                    endpoint->wMaxPacketSize == 512
                ) {
                    found_out = 1;
                }
            }
            if (found_in && found_out) {
                matched = 1;
                break;
            }
        }
    }
    libusb_free_config_descriptor(config);
    return matched ? LIBUSB_SUCCESS : LIBUSB_ERROR_NOT_FOUND;
}

static int claim_interface(libusb_device_handle *handle, int *detached) {
    *detached = 0;
    const int active = libusb_kernel_driver_active(
        handle,
        MeizuSerialInterface
    );
    if (active == 1) {
        const int detach_result = libusb_detach_kernel_driver(
            handle,
            MeizuSerialInterface
        );
        if (detach_result == LIBUSB_SUCCESS) {
            *detached = 1;
        } else if (detach_result != LIBUSB_ERROR_NOT_SUPPORTED) {
            return detach_result;
        }
    }
    const int result = libusb_claim_interface(handle, MeizuSerialInterface);
    if (result != LIBUSB_SUCCESS && *detached) {
        libusb_attach_kernel_driver(handle, MeizuSerialInterface);
        *detached = 0;
    }
    return result;
}

static int set_control_line_state(libusb_device_handle *handle) {
    const int result = libusb_control_transfer(
        handle,
        LIBUSB_ENDPOINT_OUT | LIBUSB_REQUEST_TYPE_CLASS |
            LIBUSB_RECIPIENT_INTERFACE,
        0x22,
        0x0003,
        MeizuSerialInterface,
        NULL,
        0,
        1000
    );
    /* The AN2720 implementation used by WceUsbSh may stall this optional
       request. Windows explicitly ignores that failure for 0547:2720. */
    return result < 0 && result != LIBUSB_ERROR_PIPE
        ? result
        : LIBUSB_SUCCESS;
}

static int bytes_contain(
    const unsigned char *bytes,
    int length,
    const char *needle
) {
    const size_t needle_length = strlen(needle);
    if (needle_length == 0 || needle_length > (size_t)length)
        return 0;
    for (int offset = 0;
         offset + (int)needle_length <= length;
         ++offset) {
        if (memcmp(bytes + offset, needle, needle_length) == 0)
            return 1;
    }
    return 0;
}

static int stream_contains_clientserver(
    size_t *matched,
    const unsigned char *bytes,
    size_t length
) {
    static const unsigned char handshake[] = "CLIENTSERVER";
    const size_t handshake_length = sizeof(handshake) - 1;
    for (size_t offset = 0; offset < length; ++offset) {
        if (bytes[offset] == handshake[*matched]) {
            *matched += 1;
        } else {
            /* CLIENTSERVER has no proper prefix ending in its current byte. */
            *matched = bytes[offset] == handshake[0] ? 1U : 0U;
        }
        if (*matched == handshake_length) {
            *matched = 0;
            return 1;
        }
    }
    return 0;
}

static int open_meizu_device(
    libusb_context **context,
    libusb_device_handle **handle,
    int *detached
) {
    int result = libusb_init(context);
    if (result != LIBUSB_SUCCESS)
        return result;
    *handle = libusb_open_device_with_vid_pid(
        *context,
        MeizuVendorId,
        MeizuM8SeSerialProductId
    );
    if (*handle == NULL)
        return LIBUSB_ERROR_NO_DEVICE;
    result = verify_descriptor(libusb_get_device(*handle));
    if (result != LIBUSB_SUCCESS)
        return result;
    result = claim_interface(*handle, detached);
    if (result != LIBUSB_SUCCESS)
        return result;
    return set_control_line_state(*handle);
}

static void close_meizu_device(
    libusb_context *context,
    libusb_device_handle *handle,
    int detached
) {
    if (handle != NULL) {
        libusb_release_interface(handle, MeizuSerialInterface);
        if (detached)
            libusb_attach_kernel_driver(handle, MeizuSerialInterface);
        libusb_close(handle);
    }
    if (context != NULL)
        libusb_exit(context);
}

static int probe(libusb_device_handle *handle) {
    unsigned char buffer[TransferCapacity];
    int length = 0;
    int elapsed = 0;
    while (elapsed < ProbeTimeoutMs && length < (int)sizeof(buffer)) {
        int transferred = 0;
        const int result = libusb_bulk_transfer(
            handle,
            MeizuSerialEndpointIn,
            buffer + length,
            (int)sizeof(buffer) - length,
            &transferred,
            TransferSliceMs
        );
        if (transferred > 0) {
            length += transferred;
            if (bytes_contain(buffer, length, "CLIENT")) {
                puts("MEIZU M8SE USB Serial: ready (ActiveSync CLIENT)");
                return EXIT_SUCCESS;
            }
        }
        if (result != LIBUSB_SUCCESS && result != LIBUSB_ERROR_TIMEOUT) {
            fprintf(stderr, "USB read failed: %s\n", libusb_error_name(result));
            return EXIT_FAILURE;
        }
        elapsed += TransferSliceMs;
    }
    fprintf(
        stderr,
        "MEIZU M8SE USB Serial opened, but no ActiveSync CLIENT arrived in %d ms\n",
        ProbeTimeoutMs
    );
    return EXIT_FAILURE;
}

static int write_all(int fd, const unsigned char *bytes, int length) {
    int offset = 0;
    while (offset < length) {
        const ssize_t written = write(fd, bytes + offset, (size_t)(length - offset));
        if (written > 0) {
            offset += (int)written;
        } else if (written < 0 && errno == EINTR) {
            continue;
        } else {
            return -1;
        }
    }
    return 0;
}

static int usb_write_all(
    libusb_device_handle *handle,
    const unsigned char *bytes,
    int length
) {
    int offset = 0;
    while (offset < length) {
        int transferred = 0;
        const int result = libusb_bulk_transfer(
            handle,
            MeizuSerialEndpointOut,
            (unsigned char *)bytes + offset,
            length - offset,
            &transferred,
            3000
        );
        if (transferred > 0)
            offset += transferred;
        if (result != LIBUSB_SUCCESS)
            return result;
        if (transferred == 0)
            return LIBUSB_ERROR_IO;
    }
    return LIBUSB_SUCCESS;
}

static int reconnect_meizu_device(
    libusb_context **context,
    libusb_device_handle **handle,
    int *detached
) {
    const struct timespec pause = { .tv_sec = 0, .tv_nsec = 250000000 };
    close_meizu_device(*context, *handle, *detached);
    *context = NULL;
    *handle = NULL;
    *detached = 0;
    fputs("USB=disconnected; waiting for 0547:2720\n", stderr);
    fflush(stderr);
    while (!stopped) {
        const int result = open_meizu_device(context, handle, detached);
        if (result == LIBUSB_SUCCESS) {
            fputs("USB=reconnected 0547:2720\n", stderr);
            fflush(stderr);
            return LIBUSB_SUCCESS;
        }
        close_meizu_device(*context, *handle, *detached);
        *context = NULL;
        *handle = NULL;
        *detached = 0;
        nanosleep(&pause, NULL);
    }
    return LIBUSB_ERROR_INTERRUPTED;
}

static int bridge(
    libusb_context **context,
    libusb_device_handle **handle,
    int *detached
) {
    int master = -1;
    int slave = -1;
    char slave_name[128];
    struct termios raw;
    if (openpty(&master, &slave, slave_name, NULL, NULL) != 0) {
        perror("openpty");
        return EXIT_FAILURE;
    }
    if (tcgetattr(slave, &raw) != 0) {
        perror("tcgetattr");
        close(master);
        close(slave);
        return EXIT_FAILURE;
    }
    cfmakeraw(&raw);
    if (tcsetattr(slave, TCSANOW, &raw) != 0) {
        perror("tcsetattr");
        close(master);
        close(slave);
        return EXIT_FAILURE;
    }
    const int flags = fcntl(master, F_GETFL, 0);
    if (flags < 0 || fcntl(master, F_SETFL, flags | O_NONBLOCK) != 0) {
        perror("fcntl");
        close(master);
        close(slave);
        return EXIT_FAILURE;
    }

    signal(SIGINT, stop_bridge);
    signal(SIGTERM, stop_bridge);
    signal(SIGUSR1, request_reset);
    printf("PTY=%s\n", slave_name);
    fflush(stdout);

    unsigned char buffer[TransferCapacity];
    int saw_client = 0;
    int handshake_complete = 0;
    size_t clientserver_match_length = 0;
    int64_t last_client_write_ms = 0;
    int exit_code = EXIT_SUCCESS;
    while (!stopped) {
        if (reset_requested) {
            reset_requested = 0;
            if (libusb_reset_device(*handle) != LIBUSB_SUCCESS ||
                set_control_line_state(*handle) != LIBUSB_SUCCESS) {
                if (reconnect_meizu_device(context, handle, detached) !=
                    LIBUSB_SUCCESS) {
                    break;
                }
            }
            saw_client = 0;
            handshake_complete = 0;
            clientserver_match_length = 0;
            last_client_write_ms = 0;
            fputs("USB=function reset requested\n", stderr);
            fflush(stderr);
        }
        int transferred = 0;
        int result = libusb_bulk_transfer(
            *handle,
            MeizuSerialEndpointIn,
            buffer,
            sizeof(buffer),
            &transferred,
            TransferSliceMs
        );
        if (transferred > 0) {
            if (bytes_contain(buffer, transferred, "CLIENT")) {
                if (!saw_client) {
                    fputs("USB=ActiveSync CLIENT\n", stderr);
                    fflush(stderr);
                }
                saw_client = 1;
                handshake_complete = 0;
                clientserver_match_length = 0;
                last_client_write_ms = 0;
            } else if (write_all(master, buffer, transferred) != 0) {
                fputs("PTY=unavailable; replaying ActiveSync handshake\n", stderr);
                fflush(stderr);
                saw_client = 1;
                handshake_complete = 0;
                clientserver_match_length = 0;
                last_client_write_ms = 0;
                continue;
            }
        }
        if (result != LIBUSB_SUCCESS && result != LIBUSB_ERROR_TIMEOUT) {
            if (reconnect_meizu_device(context, handle, detached) !=
                LIBUSB_SUCCESS) {
                break;
            }
            saw_client = 0;
            handshake_complete = 0;
            clientserver_match_length = 0;
            last_client_write_ms = 0;
            continue;
        }

        if (saw_client && !handshake_complete) {
            struct timespec now;
            if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
                perror("clock_gettime");
                exit_code = EXIT_FAILURE;
                break;
            }
            const int64_t now_ms =
                (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
            if (now_ms - last_client_write_ms >= 500) {
                static const unsigned char client[] = "CLIENT";
                const ssize_t written = write(
                    master,
                    client,
                    sizeof(client) - 1
                );
                if (written < 0 && (errno == EIO || errno == EAGAIN)) {
                    last_client_write_ms = now_ms;
                    continue;
                }
                if (written != (ssize_t)(sizeof(client) - 1)) {
                    perror("PTY handshake write");
                    exit_code = EXIT_FAILURE;
                    break;
                }
                last_client_write_ms = now_ms;
            }
        }

        struct pollfd pending = { .fd = master, .events = POLLIN, .revents = 0 };
        if (poll(&pending, 1, 0) > 0 && (pending.revents & POLLIN) != 0) {
            const ssize_t read_length = read(master, buffer, sizeof(buffer));
            if (read_length > 0) {
                if (!handshake_complete && stream_contains_clientserver(
                    &clientserver_match_length,
                    buffer,
                    (size_t)read_length
                )) {
                    fputs("USB=ActiveSync CLIENTSERVER\n", stderr);
                    fflush(stderr);
                    handshake_complete = 1;
                }
                result = usb_write_all(*handle, buffer, (int)read_length);
                if (result != LIBUSB_SUCCESS) {
                    if (reconnect_meizu_device(context, handle, detached) !=
                        LIBUSB_SUCCESS) {
                        break;
                    }
                    saw_client = 0;
                    handshake_complete = 0;
                    clientserver_match_length = 0;
                    last_client_write_ms = 0;
                }
            } else if (read_length < 0 && errno != EAGAIN && errno != EINTR) {
                perror("PTY read");
                exit_code = EXIT_FAILURE;
                break;
            }
        }
    }
    close(master);
    close(slave);
    return exit_code;
}

static int serial_chat(void) {
    static const unsigned char request[] = "CLIENT";
    static const unsigned char response[] = "CLIENTSERVER";
    unsigned char received[sizeof(request) - 1];
    int offset = 0;
    while (offset < (int)sizeof(received)) {
        const ssize_t length = read(
            STDIN_FILENO,
            received + offset,
            sizeof(received) - (size_t)offset
        );
        if (length > 0) {
            offset += (int)length;
        } else if (length < 0 && errno == EINTR) {
            continue;
        } else {
            return EXIT_FAILURE;
        }
    }
    if (memcmp(received, request, sizeof(received)) != 0)
        return EXIT_FAILURE;
    return write_all(
        STDOUT_FILENO,
        response,
        sizeof(response) - 1
    ) == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}

int main(int argc, char **argv) {
    if (argc != 2 ||
        (strcmp(argv[1], "probe") != 0 &&
         strcmp(argv[1], "bridge") != 0 &&
         strcmp(argv[1], "chat") != 0 &&
         strcmp(argv[1], "reset") != 0)) {
        fprintf(stderr, "usage: %s probe|bridge|chat|reset\n", argv[0]);
        return EXIT_FAILURE;
    }
    if (strcmp(argv[1], "chat") == 0)
        return serial_chat();

    libusb_context *context = NULL;
    libusb_device_handle *handle = NULL;
    int detached = 0;
    const int result = open_meizu_device(&context, &handle, &detached);
    if (result != LIBUSB_SUCCESS) {
        fprintf(
            stderr,
            "MEIZU M8SE USB Serial unavailable: %s\n",
            libusb_error_name(result)
        );
        close_meizu_device(context, handle, detached);
        return EXIT_FAILURE;
    }
    int exit_code;
    if (strcmp(argv[1], "probe") == 0) {
        exit_code = probe(handle);
    } else if (strcmp(argv[1], "reset") == 0) {
        const int reset_result = libusb_reset_device(handle);
        if (reset_result == LIBUSB_SUCCESS) {
            puts("MEIZU M8SE USB Serial: USB function reset");
            exit_code = EXIT_SUCCESS;
        } else {
            fprintf(
                stderr,
                "USB reset failed: %s\n",
                libusb_error_name(reset_result)
            );
            exit_code = EXIT_FAILURE;
        }
    } else {
        exit_code = bridge(&context, &handle, &detached);
    }
    close_meizu_device(context, handle, detached);
    return exit_code;
}

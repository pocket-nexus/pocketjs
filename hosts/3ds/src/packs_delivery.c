#include "packs_delivery.h"
#include "dev_protocol.h"
#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#ifdef __3DS__
#include "devserver.h"
#include <3ds.h>
#else
#include <time.h>
#endif

/* The cutter's pieces are 4 MiB at most; a game may cut larger ones. */
#define PIECE_MAX_BYTES (64u * 1024u * 1024u)
#define LIST_MAX_BYTES (1024u * 1024u)
#define IDLE_MS 30000u
#define TOTAL_MS (20u * 60u * 1000u)
#define BUFFER_BYTES (64u * 1024u)
#define HEADER_BYTES 8192u
#define NAME_DIGITS 20
#define PATH_BYTES 192
#define LIST "pocket.packs"

static uint64_t milliseconds(void) {
#ifdef __3DS__
  return osGetTime();
#else
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (uint64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
#endif
}

static bool fail(char *error, size_t capacity, const char *format, ...) {
  if (error && capacity) {
    va_list args;
    va_start(args, format);
    vsnprintf(error, capacity, format, args);
    va_end(args);
  }
  return false;
}

static bool pump(char *error, size_t capacity) {
#ifdef __3DS__
  devserver_poll();
  if (!devserver_connected())
    return fail(error, capacity, "cancelled: the computer disconnected");
  hidScanInput();
  const uint32_t exit_keys = KEY_L | KEY_R | KEY_START;
  if (!aptMainLoop() || (hidKeysHeld() & exit_keys) == exit_keys)
    return fail(error, capacity, "cancelled on the console");
#else
  (void)error;
  (void)capacity;
#endif
  return true;
}

static void yield_network(void) {
#ifdef __3DS__
  svcSleepThread(1000000);
#else
  const struct timespec pause = {.tv_nsec = 1000000};
  nanosleep(&pause, NULL);
#endif
}

static bool hex(const char *value, size_t digits) {
  if (!value || strlen(value) != digits)
    return false;
  for (size_t i = 0; i < digits; i++)
    if (!((value[i] >= '0' && value[i] <= '9') ||
          (value[i] >= 'a' && value[i] <= 'f')))
      return false;
  return true;
}

static bool ipv4(const char *host, struct in_addr *address) {
  if (!host || strlen(host) > 15)
    return false;
  unsigned parts[4];
  char tail;
  if (sscanf(host, "%u.%u.%u.%u%c", &parts[0], &parts[1], &parts[2], &parts[3],
             &tail) != 4)
    return false;
  for (unsigned i = 0; i < 4; i++)
    if (parts[i] > 255)
      return false;
  char canonical[16];
  snprintf(canonical, sizeof canonical, "%u.%u.%u.%u", parts[0], parts[1],
           parts[2], parts[3]);
  return strcmp(host, canonical) == 0 &&
         inet_pton(AF_INET, host, address) == 1 && parts[0] != 0 &&
         parts[0] < 224;
}

/* The computer writes each line with JSON.stringify: "key":value, no spaces.
 * The keys read here appear once a line. */
static const char *value_of(const char *json, const char *key) {
  char quoted[24];
  snprintf(quoted, sizeof quoted, "\"%s\":", key);
  const char *at = strstr(json, quoted);
  return at ? at + strlen(quoted) : NULL;
}

static bool text_of(const char *json, const char *key, char *out,
                    size_t capacity) {
  const char *at = value_of(json, key);
  if (!at || *at != '"')
    return false;
  const char *end = strchr(++at, '"');
  if (!end || (size_t)(end - at) >= capacity)
    return false;
  memcpy(out, at, end - at);
  out[end - at] = 0;
  return true;
}

static bool number_of(const char *json, const char *key, uint32_t *out) {
  const char *at = value_of(json, key);
  if (!at || *at < '0' || *at > '9')
    return false;
  uint64_t n = 0;
  for (; *at >= '0' && *at <= '9'; at++)
    if ((n = n * 10 + (*at - '0')) > 0xffffffffu)
      return false;
  *out = (uint32_t)n;
  return true;
}

/* Creates `directory` and the directories above it, below the device's root. */
static void make_directories(const char *directory) {
  char path[PATH_BYTES];
  size_t length = strlen(directory);
  if (length >= sizeof path)
    return;
  const char *colon = strchr(directory, ':');
  for (size_t i = colon ? (size_t)(colon - directory) + 2 : 1; i <= length;
       i++) {
    if (directory[i] != '/' && directory[i] != 0)
      continue;
    memcpy(path, directory, i);
    path[i] = 0;
    mkdir(path, 0777);
  }
}

/* -1 is cancellation, 0 is absent or other bytes, 1 is the file asked for. */
static int there(const char *path, uint32_t bytes, bool verify,
                 uint32_t expected_crc, char *error, size_t capacity) {
  struct stat info;
  if (stat(path, &info) != 0 || (uint64_t)info.st_size != bytes)
    return 0;
  if (!verify)
    return 1;
  FILE *file = fopen(path, "rb");
  uint8_t *buffer = malloc(BUFFER_BYTES);
  uint32_t crc = 0, total = 0;
  int result = 0;
  while (file && buffer && total < bytes) {
    if (!pump(error, capacity)) {
      result = -1;
      break;
    }
    size_t count = bytes - total;
    if (count > BUFFER_BYTES)
      count = BUFFER_BYTES;
    if (fread(buffer, 1, count, file) != count)
      break;
    crc = pocket_runtime_crc32(crc, buffer, count);
    total += count;
  }
  if (file && buffer && total == bytes && crc == expected_crc)
    result = 1;
  if (file)
    fclose(file);
  free(buffer);
  return result;
}

static bool keep_waiting(uint64_t start, uint64_t last, char *error,
                         size_t capacity) {
  if (!pump(error, capacity))
    return false;
  uint64_t now = milliseconds();
  if (now - last >= IDLE_MS || now - start >= TOTAL_MS)
    return fail(error, capacity, "the transfer timed out");
  return true;
}

static bool retryable(void) {
  return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR;
}

/* The computer sends an exact Content-Length, without compression or
 * chunking. Any other framing is refused: this is not a general HTTP client. */
static bool check_headers(char *header, uint32_t bytes, char *error,
                          size_t capacity) {
  char *line = strstr(header, "\r\n");
  if (!line)
    return fail(error, capacity, "the answer is not HTTP");
  *line = 0;
  if ((strncmp(header, "HTTP/1.1 200", 12) != 0 &&
       strncmp(header, "HTTP/1.0 200", 12) != 0) ||
      (header[12] != ' ' && header[12] != 0))
    return fail(error, capacity, "the computer did not answer 200");
  bool length_seen = false;
  while (*(line += 2)) {
    if (line[0] == '\r' && line[1] == '\n')
      break;
    char *end = strstr(line, "\r\n");
    char *colon = end ? (*end = 0, strchr(line, ':')) : NULL;
    if (!colon)
      return fail(error, capacity, "the answer's headers are not HTTP");
    *colon++ = 0;
    while (*colon == ' ' || *colon == '\t')
      colon++;
    if (strcasecmp(line, "Content-Length") == 0) {
      uint64_t length = 0;
      if (length_seen || !*colon)
        return fail(error, capacity, "the answer's length is not a number");
      for (; *colon; colon++) {
        if (*colon < '0' || *colon > '9')
          return fail(error, capacity, "the answer's length is not a number");
        if ((length = length * 10 + (*colon - '0')) > PIECE_MAX_BYTES)
          return fail(error, capacity, "the answer is longer than a piece");
      }
      if (length != bytes)
        return fail(error, capacity, "the answer has another length");
      length_seen = true;
    } else if (strcasecmp(line, "Transfer-Encoding") == 0 ||
               (strcasecmp(line, "Content-Encoding") == 0 &&
                strcasecmp(colon, "identity") != 0)) {
      return fail(error, capacity, "the answer is encoded");
    }
    line = end;
  }
  return length_seen || fail(error, capacity, "the answer names no length");
}

/* GET /<token>/<name> from the computer into `path`, through `path`.tmp: the
 * file takes its name only after its length and its CRC-32 matched. */
static bool fetch(const char *host, uint32_t port, const char *token,
                  const char *name, const char *path, uint32_t bytes,
                  uint32_t expected_crc, char *error, size_t capacity) {
  struct sockaddr_in address = {.sin_family = AF_INET};
  char temporary[PATH_BYTES + 4];
  if (!hex(token, 64) || !ipv4(host, &address.sin_addr) || !port ||
      port > 65535 || !bytes || bytes > PIECE_MAX_BYTES)
    return fail(error, capacity, "the request is not a delivery's");
  address.sin_port = htons(port);
  snprintf(temporary, sizeof temporary, "%s.tmp", path);
  uint8_t *buffer = malloc(BUFFER_BYTES);
  char *header = malloc(HEADER_BYTES + 1);
  int fd = -1;
  FILE *file = NULL;
  bool ok = false, headers_done = false;
  uint64_t start = milliseconds(), last = start;
  size_t header_bytes = 0;
  uint32_t total = 0, crc = 0;
  if (!buffer || !header) {
    fail(error, capacity, "no memory for the transfer");
    goto done;
  }
  fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0 || fcntl(fd, F_SETFL, O_NONBLOCK) < 0) {
    fail(error, capacity, "no socket");
    goto done;
  }
#ifdef SO_NOSIGPIPE
  int no_sigpipe = 1;
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof no_sigpipe);
#endif
  if (connect(fd, (struct sockaddr *)&address, sizeof address) < 0) {
    if (errno != EINPROGRESS && errno != EWOULDBLOCK) {
      fail(error, capacity, "the computer refused the connection (%d)", errno);
      goto done;
    }
    for (;;) {
      if (!keep_waiting(start, last, error, capacity))
        goto done;
      /* SOC can leave SO_ERROR at EINPROGRESS after the socket is writable.
       * A second connect answers: EALREADY while connecting, zero or EISCONN
       * once established (the same contract as svcwire.c). */
      int connected = connect(fd, (struct sockaddr *)&address, sizeof address);
      if (connected == 0 || errno == EISCONN)
        break;
      if (errno != EALREADY && errno != EINPROGRESS && !retryable()) {
        fail(error, capacity, "the computer refused the connection (%d)",
             errno);
        goto done;
      }
      yield_network();
    }
  }
  char request[256];
  size_t request_bytes = snprintf(
      request, sizeof request,
      "GET /%s/%s HTTP/1.1\r\nHost: %s:%u\r\nConnection: close\r\n\r\n", token,
      name, host, (unsigned)port);
  for (size_t sent = 0; sent < request_bytes;) {
    if (!keep_waiting(start, last, error, capacity))
      goto done;
    ssize_t n = send(fd, request + sent, request_bytes - sent, 0);
    if (n > 0) {
      sent += n;
      last = milliseconds();
    } else if (n < 0 && retryable()) {
      yield_network();
    } else {
      fail(error, capacity, "the request was not sent");
      goto done;
    }
  }
  file = fopen(temporary, "wb");
  if (!file) {
    fail(error, capacity, "the card refused a new file");
    goto done;
  }
  while (!headers_done || total < bytes) {
    if (!keep_waiting(start, last, error, capacity))
      goto done;
    ssize_t n = recv(fd, buffer, BUFFER_BYTES, 0);
    if (n < 0 && retryable()) {
      yield_network();
      continue;
    }
    if (n <= 0) {
      fail(error, capacity, "the answer ended at %lu of %lu bytes",
           (unsigned long)total, (unsigned long)bytes);
      goto done;
    }
    last = milliseconds();
    size_t body = 0;
    while (body < (size_t)n && !headers_done) {
      if (header_bytes == HEADER_BYTES || buffer[body] == 0) {
        fail(error, capacity, "the answer's headers are not HTTP");
        goto done;
      }
      header[header_bytes++] = buffer[body++];
      if (header_bytes >= 4 &&
          memcmp(header + header_bytes - 4, "\r\n\r\n", 4) == 0) {
        header[header_bytes] = 0;
        if (!check_headers(header, bytes, error, capacity))
          goto done;
        headers_done = true;
      }
    }
    size_t count = n - body;
    if (count > bytes - total) {
      fail(error, capacity, "the answer is longer than it said");
      goto done;
    }
    if (count && fwrite(buffer + body, 1, count, file) != count) {
      fail(error, capacity, "the card refused a write");
      goto done;
    }
    crc = pocket_runtime_crc32(crc, buffer + body, count);
    total += count;
  }
  if (crc != expected_crc) {
    fail(error, capacity, "the bytes that arrived have another CRC-32");
    goto done;
  }
  if (fclose(file) != 0) {
    file = NULL;
    fail(error, capacity, "the card refused the file's end");
    goto done;
  }
  file = NULL;
  /* FAT's rename does not replace a file: the old one goes first. */
  if (remove(path) != 0 && errno != ENOENT) {
    fail(error, capacity, "the card kept the old file");
    goto done;
  }
  if (rename(temporary, path) != 0) {
    fail(error, capacity, "the card refused the file's name");
    goto done;
  }
  ok = true;
done:
  if (fd >= 0)
    close(fd);
  if (file)
    fclose(file);
  if (!ok)
    remove(temporary);
  free(buffer);
  free(header);
  return ok;
}

/* Removes the pieces `directory` holds that its list does not name, and the
 * files a cancelled transfer left. Returns how many, or -1. */
static int prune(const char *directory, char *error, size_t capacity) {
  char path[PATH_BYTES];
  snprintf(path, sizeof path, "%s/" LIST, directory);
  FILE *file = fopen(path, "rb");
  char *list = malloc(LIST_MAX_BYTES + 2);
  size_t length = file && list ? fread(list + 1, 1, LIST_MAX_BYTES, file) : 0;
  if (file)
    fclose(file);
  if (!length) {
    free(list);
    fail(error, capacity, "no list of packs to prune by");
    return -1;
  }
  /* A piece's line starts with its name: a newline before it, a space after. */
  list[0] = '\n';
  list[length + 1] = 0;
  /* The names first, the removals after: the directory is not changed while it is read. */
  char (*doomed)[NAME_DIGITS + 12] = NULL;
  int found = 0, removed = 0;
  DIR *entries = opendir(directory);
  struct dirent *entry;
  while (entries && (entry = readdir(entries))) {
    size_t n = strlen(entry->d_name);
    if (n < 5 || n >= sizeof *doomed)
      continue;
    if (strcmp(entry->d_name + n - 4, ".tmp") != 0) {
      char line[NAME_DIGITS + 3], digits[NAME_DIGITS + 1];
      if (n != NAME_DIGITS + 4 || strcmp(entry->d_name + NAME_DIGITS, ".bin"))
        continue;
      memcpy(digits, entry->d_name, NAME_DIGITS);
      digits[NAME_DIGITS] = 0;
      snprintf(line, sizeof line, "\n%s ", digits);
      if (!hex(digits, NAME_DIGITS) || strstr(list, line))
        continue;
    }
    if (found % 64 == 0) {
      void *more = realloc(doomed, (found + 64) * sizeof *doomed);
      if (!more)
        break;
      doomed = more;
    }
    strcpy(doomed[found++], entry->d_name);
  }
  if (entries)
    closedir(entries);
  for (int i = 0; i < found; i++)
    if ((size_t)snprintf(path, sizeof path, "%s/%s", directory, doomed[i]) <
            sizeof path &&
        remove(path) == 0)
      removed++;
  free(doomed);
  free(list);
  return removed;
}

bool p3d_delivery(const char *line, const char *directory, char *reply,
                  size_t capacity, bool *changed) {
  if (changed)
    *changed = false;
  if (!line || !strstr(line, "\"t\":\"pocket3d.packs\""))
    return false;
  char error[96] = "", host[16] = "", token[65] = "", name[NAME_DIGITS + 1] = "";
  char path[PATH_BYTES], remote[NAME_DIGITS + 5];
  uint32_t port = 0, bytes = 0, crc = 0;
  bool asked = text_of(line, "host", host, sizeof host) &&
               number_of(line, "port", &port) &&
               text_of(line, "token", token, sizeof token) &&
               number_of(line, "bytes", &bytes) &&
               number_of(line, "crc32", &crc);
  if (value_of(line, "piece")) {
    bool ok = false, cached = false;
    if (!asked || !text_of(line, "name", name, sizeof name) ||
        !hex(name, NAME_DIGITS)) {
      name[0] = 0;
      fail(error, sizeof error, "the request names no piece");
    } else if ((size_t)snprintf(path, sizeof path, "%s/%s.bin", directory,
                                name) >= sizeof path) {
      fail(error, sizeof error, "the directory's path is longer than %u bytes",
           PATH_BYTES - NAME_DIGITS - 6);
    } else {
      int had = there(path, bytes, strstr(line, "\"verify\":true") != NULL, crc,
                      error, sizeof error);
      cached = had > 0;
      snprintf(remote, sizeof remote, "%s.bin", name);
      if (had == 0)
        make_directories(directory);
      ok = cached || (had == 0 && fetch(host, port, token, remote, path, bytes,
                                        crc, error, sizeof error));
    }
    snprintf(reply, capacity,
             "{\"t\":\"pocket3d.piece\",\"name\":\"%s\",\"ok\":%s,\"cached\":%s,"
             "\"error\":\"%s\"}",
             name, ok ? "true" : "false", cached ? "true" : "false", error);
  } else if (value_of(line, "manifest")) {
    bool ok = asked && bytes <= LIST_MAX_BYTES &&
              (size_t)snprintf(path, sizeof path, "%s/" LIST, directory) <
                  sizeof path;
    if (!ok)
      fail(error, sizeof error, "the request names no list");
    else {
      make_directories(directory);
      ok = fetch(host, port, token, LIST, path, bytes, crc, error, sizeof error);
    }
    if (changed)
      *changed = ok;
    snprintf(reply, capacity,
             "{\"t\":\"pocket3d.manifest\",\"ok\":%s,\"error\":\"%s\"}",
             ok ? "true" : "false", error);
  } else if (value_of(line, "prune")) {
    int removed = prune(directory, error, sizeof error);
    snprintf(reply, capacity,
             "{\"t\":\"pocket3d.pruned\",\"ok\":%s,\"removed\":%d,\"error\":\"%s\"}",
             removed >= 0 ? "true" : "false", removed < 0 ? 0 : removed, error);
  } else {
    snprintf(reply, capacity,
             "{\"t\":\"pocket3d.packs\",\"ok\":false,\"error\":\"no such step\"}");
  }
  return true;
}

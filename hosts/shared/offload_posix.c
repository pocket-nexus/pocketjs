#include "offload_posix.h"
#include "offload_queue.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

static OffloadQueue outgoing, incoming;
static _Atomic unsigned generation, stopping;
static pthread_t worker;
static int started;
static char key_file[1024];
static unsigned listen_port;

static int transfer(int fd, void *data, size_t size, int sending) {
  char *p = data;
#ifdef MSG_NOSIGNAL
  int flags = MSG_NOSIGNAL;
#else
  int flags = 0;
#endif
  while (size && !atomic_load(&stopping)) {
    ssize_t n = sending ? send(fd, p, size, flags) : recv(fd, p, size, 0);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return 0;
    p += n; size -= (size_t)n;
  }
  return size == 0;
}
static int read_key(char key[64]) {
  FILE *f = fopen(key_file, "rb");
  if (!f) return 0;
  size_t n = fread(key, 1, 64, f);
  int extra = fgetc(f);
  fclose(f);
  if (n != 64 || (extra != EOF && extra != '\n')) return 0;
  for (unsigned i = 0; i < 64; i++)
    if (!((key[i] >= '0' && key[i] <= '9') || (key[i] >= 'a' && key[i] <= 'f'))) return 0;
  return 1;
}
static void *serve(void *unused) {
  (void)unused;
  unsigned next_generation = 0;
  int listener = socket(AF_INET, SOCK_STREAM, 0);
  if (listener < 0) return NULL;
  int yes = 1;
  setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);
  struct sockaddr_in address;
  memset(&address, 0, sizeof address);
  address.sin_family = AF_INET;
  /* USB forwards connect to device loopback. No LAN text-input listener. */
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = htons((uint16_t)listen_port);
  if (bind(listener, (struct sockaddr *)&address, sizeof address) || listen(listener, 1)) {
    close(listener); return NULL;
  }
  while (!atomic_load(&stopping)) {
    struct pollfd ready = {listener, POLLIN, 0};
    if (poll(&ready, 1, 20) <= 0) continue;
    int fd = accept(listener, NULL, NULL);
    if (fd < 0) continue;
    struct timeval timeout = {1, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof timeout);
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &yes, sizeof yes);
#ifdef SO_NOSIGPIPE
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof yes);
#endif
    char expected[64], received[64];
    int authenticated = read_key(expected) && transfer(fd, received, 64, 0);
    unsigned difference = 0;
    if (authenticated) for (unsigned i = 0; i < 64; i++) difference |= (unsigned char)expected[i] ^ (unsigned char)received[i];
    if (!authenticated || difference) { close(fd); continue; }
    unsigned current = ++next_generation;
    if (!current) current = ++next_generation;
    atomic_store(&generation, current);
    time_t heartbeat = 0;
    while (!atomic_load(&stopping)) {
      struct timeval now; gettimeofday(&now, NULL);
      if (now.tv_sec != heartbeat) {
        heartbeat = now.tv_sec;
        char metrics[160];
        int n = snprintf(metrics, sizeof metrics, "{\"v\":1,\"id\":0,\"method\":\"offload.metrics\",\"payload\":\"session=%u\"}", current);
        uint32_t header = htonl((uint32_t)n);
        if (!transfer(fd, &header, 4, 1) || !transfer(fd, metrics, (size_t)n, 1)) break;
      }
      OffloadRecord record;
      if (offload_pop(&outgoing, &record) && record.generation == current) {
        uint32_t header = htonl(record.length);
        if (!transfer(fd, &header, 4, 1) || !transfer(fd, record.bytes, record.length, 1)) break;
      }
      ready.fd = fd; ready.events = POLLIN; ready.revents = 0;
      int available = poll(&ready, 1, 2);
      if (available < 0 && errno != EINTR) break;
      if (available <= 0) continue;
      uint32_t header;
      if (!transfer(fd, &header, 4, 0)) break;
      unsigned length = ntohl(header);
      if (!length || length > OFFLOAD_BYTES || !transfer(fd, record.bytes, length, 0)) break;
      if (!offload_push(&incoming, record.bytes, length, current)) break;
    }
    atomic_store(&generation, 0);
    close(fd);
  }
  close(listener);
  return NULL;
}
void pocket_offload_start(const char *path, unsigned port) {
  if (started || !path || !*path || strlen(path) >= sizeof key_file || !port || port > 65535) return;
  strcpy(key_file, path); listen_port = port;
  atomic_store(&stopping, 0);
  started = pthread_create(&worker, NULL, serve, NULL) == 0;
}
void pocket_offload_stop(void) {
  if (!started) return;
  atomic_store(&stopping, 1);
  pthread_join(worker, NULL);
  started = 0;
  atomic_store(&generation, 0);
  memset(&outgoing, 0, sizeof outgoing);
  memset(&incoming, 0, sizeof incoming);
}
unsigned pocket_offload_session(void) { return atomic_load(&generation); }
int pocket_offload_submit(const char *bytes, size_t length) {
  unsigned session = pocket_offload_session();
  return session && length <= OFFLOAD_BYTES && offload_push(&outgoing, bytes, (uint32_t)length, session);
}
size_t pocket_offload_take(char *bytes) {
  OffloadRecord record;
  if (!offload_pop(&incoming, &record) || record.generation != pocket_offload_session()) return 0;
  memcpy(bytes, record.bytes, record.length);
  return record.length;
}

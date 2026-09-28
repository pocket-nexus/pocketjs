#include "../../../hosts/3ds/src/relay.h"
#include <3ds.h>
#include <arpa/inet.h>
#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#ifndef POCKETJS_RELAY_KEY
#error "test key path required"
#endif
#ifndef POCKETJS_RELAY_HOST
#error "test host path required"
#endif

static const char key[] = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
static _Atomic int phase;
static int listener;

bool soc_ensure(char *error, size_t size) { (void)error; (void)size; return true; }
static void put32(uint8_t *at, uint32_t value) {
  at[0] = (uint8_t)value; at[1] = (uint8_t)(value >> 8);
  at[2] = (uint8_t)(value >> 16); at[3] = (uint8_t)(value >> 24);
}
static uint32_t get32(const uint8_t *at) {
  return (uint32_t)at[0] | (uint32_t)at[1] << 8 |
    (uint32_t)at[2] << 16 | (uint32_t)at[3] << 24;
}
static void record(uint8_t *into, size_t length, uint8_t marker) {
  assert(length >= 51 && length <= 16384);
  memset(into, marker, length);
  put32(into, (uint32_t)length - 4);
  memcpy(into + 4, "PRLY", 4);
  into[8] = 1; into[9] = 0; into[10] = 1; into[11] = 0;
  into[12] = 48; into[13] = into[14] = into[15] = 0;
  memset(into + 16, 0, 32);
  put32(into + 36, 2);
  put32(into + 40, (uint32_t)length - 50);
  into[48] = '{'; into[49] = '}'; into[50] = marker;
}
static void send_all(int fd, const void *bytes, size_t length) {
  const uint8_t *at = bytes;
  while (length) { ssize_t n = send(fd, at, length, 0); assert(n > 0); at += n; length -= (size_t)n; }
}
static void read_all(int fd, void *bytes, size_t length) {
  uint8_t *at = bytes;
  while (length) { ssize_t n = recv(fd, at, length, 0); assert(n > 0); at += n; length -= (size_t)n; }
}
static void expect_key(int fd) {
  char offered[64]; read_all(fd, offered, sizeof offered);
  assert(memcmp(offered, key, sizeof offered) == 0);
}
static void expect_record(int fd, uint8_t marker) {
  uint8_t bytes[16384]; read_all(fd, bytes, 4);
  size_t length = get32(bytes) + 4;
  assert(length >= 51 && length <= sizeof bytes);
  read_all(fd, bytes + 4, length - 4);
  assert(bytes[50] == marker && memcmp(bytes + 4, "PRLY", 4) == 0);
}
static void until(int expected) {
  u64 deadline = osGetTime() + 5000;
  while (atomic_load(&phase) < expected && osGetTime() < deadline) svcSleepThread(1000000);
  assert(atomic_load(&phase) >= expected);
}
static void *serve(void *unused) {
  (void)unused;
  int fd = accept(listener, NULL, NULL); assert(fd >= 0);
  expect_key(fd);
  expect_record(fd, 1); expect_record(fd, 2);
  uint8_t first[1000], second[4000], third[51];
  record(first, sizeof first, 5); record(second, sizeof second, 6); record(third, sizeof third, 7);
  send_all(fd, first, 3); svcSleepThread(5000000); send_all(fd, first + 3, sizeof first - 3);
  uint8_t joined[sizeof second + sizeof third];
  memcpy(joined, second, sizeof second); memcpy(joined + sizeof second, third, sizeof third);
  send_all(fd, joined, sizeof joined);
  until(1); close(fd);

  fd = accept(listener, NULL, NULL); assert(fd >= 0);
  expect_key(fd); expect_record(fd, 3);
  until(2); close(fd);

  fd = accept(listener, NULL, NULL); assert(fd >= 0);
  expect_key(fd); expect_record(fd, 4);
  record(third, sizeof third, 9); send_all(fd, third, sizeof third);
  until(3);
  uint8_t full[8192];
  for (uint8_t marker = 10; marker <= 18; marker++) {
    record(full, sizeof full, marker);
    send_all(fd, full, sizeof full);
  }
  until(4); close(fd);
  return NULL;
}
static int connected_after(int previous) {
  u64 deadline = osGetTime() + 8000;
  while (osGetTime() < deadline) {
    int session = relay_session();
    if (session > previous) return session;
    svcSleepThread(1000000);
  }
  assert(0 && "native relay did not reconnect");
  return 0;
}
static void send_record(uint8_t marker) {
  uint8_t bytes[64]; record(bytes, sizeof bytes, marker);
  assert(relay_send(bytes, sizeof bytes));
}
int main(void) {
  assert(!relay_start()); /* No configuration: the guest keeps offload. */
  FILE *file = fopen(POCKETJS_RELAY_KEY, "wb"); assert(file);
  assert(fwrite(key, 1, 64, file) == 64); fclose(file);
  listener = socket(AF_INET, SOCK_STREAM, 0); assert(listener >= 0);
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = 0 };
  assert(inet_aton("127.0.0.1", &address.sin_addr));
  assert(bind(listener, (struct sockaddr *)&address, sizeof address) == 0);
  assert(listen(listener, 2) == 0);
  socklen_t length = sizeof address;
  assert(getsockname(listener, (struct sockaddr *)&address, &length) == 0);
  file = fopen(POCKETJS_RELAY_HOST, "wb"); assert(file);
  fprintf(file, "127.0.0.1:%u\n", ntohs(address.sin_port)); fclose(file);
  pthread_t server; assert(pthread_create(&server, NULL, serve, NULL) == 0);
  assert(relay_start() && relay_available());

  int first = connected_after(0);
  relay_frame();
  uint8_t bytes[64]; record(bytes, sizeof bytes, 1);
  assert(!relay_send(bytes, sizeof bytes - 1)); /* No partial record. */
  send_record(1); send_record(2);
  record(bytes, sizeof bytes, 3);
  assert(!relay_send(bytes, sizeof bytes)); /* Two submissions per frame. */

  unsigned received = 0;
  u64 deadline = osGetTime() + 5000;
  while (received < 3 && osGetTime() < deadline) {
    relay_frame();
    uint8_t into[16384];
    for (unsigned i = 0; i < 2; i++) {
      size_t n = relay_take(into, sizeof into);
      if (n) { assert(into[50] == 5 + received); received++; }
    }
    svcSleepThread(1000000);
  }
  assert(received == 3);
  atomic_store(&phase, 1);

  int second = connected_after(first);
  relay_frame(); send_record(3);
  svcSleepThread(20000000);
  relay_reset(); assert(relay_session() == 0);
  atomic_store(&phase, 2);
  int third = connected_after(second);
  relay_frame(); send_record(4);
  deadline = osGetTime() + 5000;
  char stats[256];
  while (osGetTime() < deadline) {
    relay_stats(stats, sizeof stats);
    if (strstr(stats, "in=51/1")) break;
    svcSleepThread(1000000);
  }
  assert(strstr(stats, "in=51/1") && third > second);
  relay_frame();
  uint8_t short_buffer[32];
  assert(relay_take(short_buffer, sizeof short_buffer) == 0); /* Drop, never truncate. */
  atomic_store(&phase, 3);
  deadline = osGetTime() + 5000;
  while (osGetTime() < deadline) {
    relay_stats(stats, sizeof stats);
    if (strstr(stats, "in=65536/8")) break;
    svcSleepThread(1000000);
  }
  assert(strstr(stats, "in=65536/8")); /* Ninth record waits for credit. */
  received = 0;
  deadline = osGetTime() + 5000;
  while (received < 9 && osGetTime() < deadline) {
    relay_frame();
    uint8_t into[16384];
    for (unsigned i = 0; i < 2; i++) {
      size_t n = relay_take(into, sizeof into);
      if (n) { assert(n == 8192 && into[50] == 10 + received); received++; }
    }
    svcSleepThread(1000000);
  }
  assert(received == 9);
  atomic_store(&phase, 4);
  pthread_join(server, NULL);
  relay_stop(); close(listener);
  puts("native Relay pairing, framing, frame credit and realm-reset reconnect passed");
}

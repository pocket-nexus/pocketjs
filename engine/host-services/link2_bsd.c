/*
 * The socket half of a Link2Platform from BSD sockets, which POSIX and the
 * 3DS (libctru's SOC service) both provide: non-blocking TCP for the link and
 * one UDP socket for beacons. A handle is the socket's descriptor.
 */

#include "link2.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#if __has_include(<netinet/tcp.h>)
#include <netinet/tcp.h>
#endif
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static bool non_blocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

static bool would_block(void) {
  return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR;
}

/* The address of the connect in flight: the client dials one Hub at a time. */
static struct sockaddr_in dialed;
static int dialed_fd = -1;

static int bsd_tcp_connect(void *context, const char *address, uint16_t port) {
  (void)context;
  memset(&dialed, 0, sizeof dialed);
  dialed.sin_family = AF_INET;
  dialed.sin_port = htons(port);
  if (inet_pton(AF_INET, address, &dialed.sin_addr) != 1) return -1;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
#ifdef SO_NOSIGPIPE
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
#ifdef TCP_NODELAY
  int nodelay = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof nodelay);
#endif
  if (!non_blocking(fd)) {
    close(fd);
    return -1;
  }
  int rc = connect(fd, (struct sockaddr *)&dialed, sizeof dialed);
  if (rc != 0 && errno != EINPROGRESS && errno != EWOULDBLOCK && errno != EALREADY) {
    close(fd);
    return -1;
  }
  dialed_fd = fd;
  return fd;
}

/* Calling connect again is the test that works on the 3DS as on POSIX
 * (version 1's client does the same): 0 or EISCONN once connected, EALREADY
 * or EINPROGRESS while the connect is in flight. */
static int bsd_tcp_connected(void *context, int fd) {
  (void)context;
  if (fd != dialed_fd) return -1;
  int rc = connect(fd, (struct sockaddr *)&dialed, sizeof dialed);
  if (rc == 0 || errno == EISCONN) return 1;
  if (errno == EALREADY || errno == EINPROGRESS || errno == EWOULDBLOCK) return 0;
  return -1;
}

static long bsd_tcp_send(void *context, int fd, const uint8_t *bytes, size_t length) {
  (void)context;
#ifdef MSG_NOSIGNAL
  ssize_t n = send(fd, bytes, length, MSG_NOSIGNAL);
#else
  ssize_t n = send(fd, bytes, length, 0);
#endif
  if (n >= 0) return (long)n;
  return would_block() ? 0 : -1;
}

static long bsd_tcp_recv(void *context, int fd, uint8_t *into, size_t capacity) {
  (void)context;
  ssize_t n = recv(fd, into, capacity, 0);
  if (n > 0) return (long)n;
  if (n == 0) return -1; /* the peer closed */
  return would_block() ? 0 : -1;
}

static void bsd_tcp_close(void *context, int fd) {
  (void)context;
  close(fd);
}

static int bsd_udp_open(void *context, uint16_t port) {
  (void)context;
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) return -1;
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in at;
  memset(&at, 0, sizeof at);
  at.sin_family = AF_INET;
  at.sin_port = htons(port);
  at.sin_addr.s_addr = htonl(INADDR_ANY);
  if (!non_blocking(fd) || bind(fd, (struct sockaddr *)&at, sizeof at) != 0) {
    close(fd);
    return -1;
  }
  return fd;
}

static long bsd_udp_recv(void *context, int fd, uint8_t *into, size_t capacity, char address[16]) {
  (void)context;
  struct sockaddr_in from;
  socklen_t length = sizeof from;
  ssize_t n = recvfrom(fd, into, capacity, 0, (struct sockaddr *)&from, &length);
  /* No datagram is 0; a socket that failed is -1, and the client opens another. */
  if (n < 0) return would_block() ? 0 : -1;
  if (n == 0) return 0;
  if (inet_ntop(AF_INET, &from.sin_addr, address, 16) == NULL) return 0;
  return (long)n;
}

static void bsd_udp_close(void *context, int fd) {
  (void)context;
  close(fd);
}

void link2_bsd_sockets(Link2Platform *platform) {
  platform->tcp_connect = bsd_tcp_connect;
  platform->tcp_connected = bsd_tcp_connected;
  platform->tcp_send = bsd_tcp_send;
  platform->tcp_recv = bsd_tcp_recv;
  platform->tcp_close = bsd_tcp_close;
  platform->udp_open = bsd_udp_open;
  platform->udp_recv = bsd_udp_recv;
  platform->udp_close = bsd_udp_close;
}

/* engine/host-services/link2_http.c on the host, with a stub of the client's
 * net.http calls. One scenario: a response the worker has not finished reading
 * when the link drops, and the first request of the next connection, which
 * gets the same wire id (the client's ids start again at every `ready`). The
 * worker's handle for the second request must name the second request's
 * response and nothing of the first. */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "link_http.h"
#include "link2_guest.h"
#include "host_services.h"
#include "launcher.h"

struct Link2 { int unused; };
static struct Link2 client;
static uint32_t next_id;
static uint32_t cancelled[16];
static int cancels;
static uint32_t consumed_wire[16];
static int consumes;

uint64_t services_host_ms(void) { return 1000; }
const char *launcher_current_app_id(void) { return "test.worker"; }
uint32_t link2_http(Link2 *link, const Link2HttpRequest *request) { (void)link; (void)request; return next_id++; }
void link2_http_consumed(Link2 *link, uint32_t request, uint32_t bytes) { (void)link; (void)bytes; consumed_wire[consumes++ % 16] = request; }
void link2_http_cancel(Link2 *link, uint32_t request) { (void)link; cancelled[cancels++ % 16] = request; }

static const char *kind(uint32_t k) {
  return k == POCKET_WORKER_HEADERS ? "HEADERS" : k == POCKET_WORKER_DATA ? "DATA" : k == POCKET_WORKER_END ? "END" : "?";
}

static void drain(const char *name, int32_t handle) {
  LinkHttpFact fact;
  printf("%s reads:", name);
  for (int i = 0; i < 6 && link_http_peek((uint32_t)handle, &fact); i += 1) {
    printf(" %s", kind(fact.kind));
    if (fact.kind == POCKET_WORKER_END) printf("(%d,%llu)", (int)fact.status, (unsigned long long)fact.offset);
    else printf("(%.*s)", fact.kind == POCKET_WORKER_DATA ? (int)fact.length : 0, (const char *)fact.bytes);
    bool end = fact.kind == POCKET_WORKER_END;
    link_http_consume((uint32_t)handle);
    if (end) break; /* the worker reads no more of a resource after its END */
  }
  printf("\n");
}

int main(void) {
  Link2Host host;
  memset(&host, 0, sizeof host);
  link2_http_host(&host);
  link2_http_bind(&client);
  const char a_config[] = "{\"url\":\"https://example.com/a\"}";
  const char b_config[] = "{\"url\":\"https://example.com/b\"}";
  const char head_a[] = "{\"status\":200,\"url\":\"https://example.com/a\",\"headers\":{}}";
  const char head_b[] = "{\"status\":200,\"url\":\"https://example.com/b\",\"headers\":{}}";
  LinkHttpFact fact;

  /* Connection 1: the worker's first request gets wire id 3. */
  next_id = 3;
  int32_t a = link_http_start((const uint8_t *)a_config, sizeof a_config - 1);
  host.http_head(NULL, 3, head_a, sizeof head_a - 1);
  host.http_data(NULL, 3, (const uint8_t *)"AAAAAAAA", 8);
  /* The worker took the head and has not read the body yet. */
  assert(link_http_peek((uint32_t)a, &fact) && fact.kind == POCKET_WORKER_HEADERS);
  link_http_consume((uint32_t)a);

  /* The link drops. */
  host.http_end(NULL, 3, "closed");
  link_http_disconnected();

  /* Connection 2: the ids start again, and the worker's next request is again wire id 3. */
  next_id = 3;
  int32_t b = link_http_start((const uint8_t *)b_config, sizeof b_config - 1);
  printf("handles differ: %s\n", a != b && a > 0 && b > 0 ? "yes" : "no");
  host.http_head(NULL, 3, head_b, sizeof head_b - 1);
  host.http_data(NULL, 3, (const uint8_t *)"BBBBBBBBBBBB", 12);
  host.http_end(NULL, 3, NULL);

  drain("B", b);
  drain("A", a);
  /* B's DATA was consumed on the connection that is up: its wire id 3. A's left no CREDIT and no CANCEL behind. */
  printf("consumed on the wire:");
  for (int i = 0; i < consumes; i += 1) printf(" %u", (unsigned)consumed_wire[i]);
  printf("\ncancels sent: %d\n", cancels);
  link_http_close((uint32_t)a);
  link_http_close((uint32_t)b);
  printf("cancels after both closed: %d\n", cancels);
  return 0;
}

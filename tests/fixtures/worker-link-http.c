#include "link_http.h"
#include "link.h"
#include "host_services.h"
#include "launcher.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static uint32_t serial;
static char last[2048];
bool link_http_available(void) {return true;}
bool link_send_ctrl(const char *text,size_t length) {assert(length<sizeof last);memcpy(last,text,length);last[length]=0;return true;}
bool link_send_data(uint32_t id,const uint8_t *data,size_t length) {(void)id;(void)data;(void)length;return true;}
uint32_t link_new_stream(void) {return ++serial;}
uint64_t services_host_ms(void) {return 1000;}
const char *launcher_current_app_id(void) {return "test.worker";}
int main(void) {
  const char config[]="{\"url\":\"https://example.com/\"}";
  int32_t id=link_http_start((const uint8_t *)config,sizeof config-1);assert(id>0);
  const char header[]="{\"status\":200,\"url\":\"https://example.com/\",\"headers\":{}}";
  assert(link_http_ctrl("net.head",(uint32_t)id,header,sizeof header-1));
  /* Tiny network frames share ring slots; byte credit must not turn into a
   * smaller accidental record-count window. */
  for (size_t i=0;i<LINK_HTTP_WINDOW;++i) {uint8_t byte=(uint8_t)i;assert(link_http_data((uint32_t)id,&byte,1));}
  link_http_disconnected();
  LinkHttpFact fact;
  assert(link_http_peek((uint32_t)id,&fact) && fact.kind==LINK_HTTP_HEADERS);
  link_http_consume((uint32_t)id);
  for (size_t i=0;i<8;++i) {
    assert(link_http_peek((uint32_t)id,&fact) && fact.kind==LINK_HTTP_DATA && fact.length==1024 && fact.offset==i*1024);
    for (size_t j=0;j<fact.length;++j) assert(fact.bytes[j]==(uint8_t)j);
    link_http_consume((uint32_t)id);
  }
  assert(link_http_peek((uint32_t)id,&fact) && fact.kind==LINK_HTTP_END && fact.status==-3 && fact.offset==8192);
  link_http_consume((uint32_t)id);assert(!link_http_peek((uint32_t)id,&fact));
  int32_t next=link_http_start((const uint8_t *)config,sizeof config-1);assert(next>id);
  assert(!link_http_data((uint32_t)id,(const uint8_t *)"x",1));
  link_http_close((uint32_t)next);assert(strstr(last,"net.cancel"));
  const char limited[]="{\"url\":\"https://example.com/\",\"maxBytes\":3}";
  next=link_http_start((const uint8_t *)limited,sizeof limited-1);assert(next>id);
  assert(link_http_ctrl("net.head",(uint32_t)next,header,sizeof header-1));
  assert(link_http_data((uint32_t)next,(const uint8_t *)"abc",3));
  assert(link_http_data((uint32_t)next,(const uint8_t *)"x",1));
  assert(strstr(last,"net.cancel"));
  assert(link_http_peek((uint32_t)next,&fact) && fact.kind==LINK_HTTP_HEADERS);
  link_http_consume((uint32_t)next);
  assert(link_http_peek((uint32_t)next,&fact) && fact.kind==LINK_HTTP_DATA && fact.length==3 && fact.offset==0);
  link_http_consume((uint32_t)next);
  assert(link_http_peek((uint32_t)next,&fact) && fact.kind==LINK_HTTP_END && fact.status==-1 && fact.offset==3);
  link_http_consume((uint32_t)next);
  puts("link HTTP window, terminal reservation, response limit and stale ids pass");
  return 0;
}

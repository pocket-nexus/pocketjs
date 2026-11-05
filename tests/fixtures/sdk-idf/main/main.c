#include "consumer.h"
#ifdef ESP_PLATFORM
void app_main(void) { fixture_run(); }
#else
int main(void) { fixture_run(); return 0; }
#endif

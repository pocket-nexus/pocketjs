/* The sizes of the C structs runner.rs mirrors, for its layout test. */
#include <pocket/worker.h>
#include <pocket/worker_quickjs.h>
#include <pocket/worker_runner.h>
#include <stddef.h>

size_t pocket_linux_worker_layout(int which) {
  switch (which) {
  case 0: return sizeof(pocket_worker_runner_config);
  case 1: return sizeof(pocket_worker_config);
  case 2: return sizeof(pocket_worker_quickjs_config);
  case 3: return sizeof(pocket_worker_driver);
  case 4: return sizeof(pocket_worker_node);
  default: return 0;
  }
}

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>

BOOL WINAPI pocket_process_first(HANDLE snapshot, PROCESSENTRY32W *process)
  __asm__("Process32First");
BOOL WINAPI pocket_process_next(HANDLE snapshot, PROCESSENTRY32W *process)
  __asm__("Process32Next");

static const WCHAR *basename_w(const WCHAR *path) {
  const WCHAR *name = path;
  while (*path != L'\0') {
    if (*path == L'\\' || *path == L'/') name = path + 1;
    path += 1;
  }
  return name;
}

static int is_pocketjs_runtime(const WCHAR *path) {
  static const WCHAR legacy[] = L"PocketJS.exe";
  static const WCHAR versioned_prefix[] = L"PocketJS-";
  const WCHAR *name = basename_w(path);
  unsigned int index;
  if (lstrcmpiW(name, legacy) == 0) return 1;
  for (index = 0; versioned_prefix[index] != L'\0'; index += 1) {
    WCHAR current = name[index];
    WCHAR expected = versioned_prefix[index];
    if (current >= L'a' && current <= L'z') current -= L'a' - L'A';
    if (expected >= L'a' && expected <= L'z') expected -= L'a' - L'A';
    if (current != expected) return 0;
  }
  return 1;
}

int WINAPI WinMain(
  HINSTANCE instance,
  HINSTANCE previous,
  LPWSTR command_line,
  int show
) {
  DWORD targets[64];
  unsigned int pass;
  unsigned int target_count;
  unsigned int index;
  PROCESSENTRY32W process;
  HANDLE snapshot;
  (void)instance;
  (void)previous;
  (void)command_line;
  (void)show;
  for (pass = 0; pass < 16; pass += 1) {
    HWND runtime_window = FindWindowW(L"PocketJSMeizuM8", NULL);
    if (runtime_window != NULL) {
      PostMessageW(runtime_window, WM_CLOSE, 0, 0);
      Sleep(50);
    }
    target_count = 0;
    snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return 2;
    process.dwSize = sizeof(process);
    if (pocket_process_first(snapshot, &process)) {
      do {
        if (process.th32ProcessID != GetCurrentProcessId() &&
            is_pocketjs_runtime(process.szExeFile) &&
            target_count < sizeof(targets) / sizeof(targets[0])) {
          targets[target_count++] = process.th32ProcessID;
        }
        process.dwSize = sizeof(process);
      } while (pocket_process_next(snapshot, &process));
    }
    CloseHandle(snapshot);
    if (target_count == 0) break;
    for (index = 0; index < target_count; index += 1) {
      HANDLE target = OpenProcess(PROCESS_TERMINATE, FALSE, targets[index]);
      if (target != NULL) {
        TerminateProcess(target, 0);
        CloseHandle(target);
      }
    }
    Sleep(50);
  }
  return 0;
}

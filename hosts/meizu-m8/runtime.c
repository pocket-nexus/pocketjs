#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "pocket_runtime.h"

#ifndef POCKET_BUILD_ID
#define POCKET_BUILD_ID "unknown"
#endif
#ifndef POCKET_LOGICAL_WIDTH
#define POCKET_LOGICAL_WIDTH 480
#endif
#ifndef POCKET_LOGICAL_HEIGHT
#define POCKET_LOGICAL_HEIGHT 720
#endif

#define POCKET_TIMER_ID 1
#define POCKET_TIMER_MS 17
#define POCKET_WIDEN_INNER(value) L##value
#define POCKET_WIDEN(value) POCKET_WIDEN_INNER(value)
#define POCKET_STATUS_PATH \
  L"\\Temp\\pocketjs-meizu-m8-" POCKET_WIDEN(POCKET_BUILD_ID) L".status"
#define POCKET_FRAME_PATH \
  L"\\Temp\\pocketjs-meizu-m8-" POCKET_WIDEN(POCKET_BUILD_ID) L".frame.bmp"
#define POCKET_FRAME_TEMP_PATH \
  L"\\Temp\\pocketjs-meizu-m8-" POCKET_WIDEN(POCKET_BUILD_ID) L".frame.tmp"

extern const unsigned char pocket_app_js[];
extern const unsigned int pocket_app_js_len;
extern const unsigned char pocket_app_pak[];
extern const unsigned int pocket_app_pak_len;

static HWND window_handle;
static const uint8_t *framebuffer;
static int touch_down;
static int touch_x;
static int touch_y;
static int touch_hit;
static int touch_was_sent;
static int touch_release_after_frame;
static unsigned long frames;
static unsigned long gdi_composites;
static unsigned long touch_sequences;
static unsigned long completed_touch_sequences;
static unsigned long observed_action_sequence;
static unsigned long capture_attempts;
static unsigned long capture_successes;
static unsigned long capture_error;
static int capture_pending;
static int boot_stage;
static char runtime_error[512];

static void copy_error(const char *message) {
  size_t length = message == NULL ? 0 : strlen(message);
  if (length >= sizeof(runtime_error)) length = sizeof(runtime_error) - 1;
  if (length != 0) memcpy(runtime_error, message, length);
  runtime_error[length] = '\0';
}

static void write_status(const char *state) {
  char record[1024];
  DWORD written = 0;
  HANDLE file;
  const char *action_name = pocket_legacy_runtime_action_name();
  int length = snprintf(
    record,
    sizeof(record),
    "schema=1\r\n"
    "build_id=%s\r\n"
    "state=%s\r\n"
    "boot_stage=%d\r\n"
    "pid=%lu\r\n"
    "uptime_ms=%lu\r\n"
    "guest_frames=%lu\r\n"
    "gdi_composites=%lu\r\n"
    "touch_sequences=%lu\r\n"
    "completed_touch_sequences=%lu\r\n"
    "touch_down=%d\r\n"
    "last_touch_x=%d\r\n"
    "last_touch_y=%d\r\n"
    "last_touch_hit=%d\r\n"
    "action_name=%.63s\r\n"
    "action_value=%d\r\n"
    "action_sequence=%lu\r\n"
    "capture_attempts=%lu\r\n"
    "capture_successes=%lu\r\n"
    "capture_error=%lu\r\n"
    "renderer=gdi-software\r\n"
    "logical_viewport=%dx%d\r\n"
    "physical_viewport=%dx%d\r\n"
    "error=%.383s\r\n",
    POCKET_BUILD_ID,
    state,
    boot_stage,
    (unsigned long)GetCurrentProcessId(),
    (unsigned long)GetTickCount(),
    frames,
    gdi_composites,
    touch_sequences,
    completed_touch_sequences,
    touch_down,
    touch_x,
    touch_y,
    touch_hit,
    action_name == NULL ? "" : action_name,
    pocket_legacy_runtime_action_value(),
    pocket_legacy_runtime_action_sequence(),
    capture_attempts,
    capture_successes,
    capture_error,
    POCKET_LOGICAL_WIDTH,
    POCKET_LOGICAL_HEIGHT,
    GetSystemMetrics(SM_CXSCREEN),
    GetSystemMetrics(SM_CYSCREEN),
    runtime_error
  );
  if (length <= 0) return;
  if (length >= (int)sizeof(record)) length = (int)sizeof(record) - 1;
  file = CreateFileW(
    POCKET_STATUS_PATH,
    GENERIC_WRITE,
    FILE_SHARE_READ,
    NULL,
    CREATE_ALWAYS,
    FILE_ATTRIBUTE_NORMAL,
    NULL
  );
  if (file == INVALID_HANDLE_VALUE) return;
  WriteFile(file, record, (DWORD)length, &written, NULL);
  FlushFileBuffers(file);
  CloseHandle(file);
}

void pocket_host_boot_stage(int stage) {
  boot_stage = stage;
  write_status("starting");
}

void *pocket_legacy_host_alloc(size_t size) {
  return HeapAlloc(GetProcessHeap(), 0, size);
}

void *pocket_legacy_host_realloc(void *pointer, size_t size) {
  if (pointer == NULL) return HeapAlloc(GetProcessHeap(), 0, size);
  return HeapReAlloc(GetProcessHeap(), 0, pointer, size);
}

void pocket_legacy_host_free(void *pointer) {
  if (pointer != NULL) HeapFree(GetProcessHeap(), 0, pointer);
}

static void put_u16_le(uint8_t *bytes, unsigned int offset, uint16_t value) {
  bytes[offset] = (uint8_t)value;
  bytes[offset + 1] = (uint8_t)(value >> 8);
}

static void put_u32_le(uint8_t *bytes, unsigned int offset, uint32_t value) {
  bytes[offset] = (uint8_t)value;
  bytes[offset + 1] = (uint8_t)(value >> 8);
  bytes[offset + 2] = (uint8_t)(value >> 16);
  bytes[offset + 3] = (uint8_t)(value >> 24);
}

static void write_framebuffer_bmp(void) {
  uint8_t header[54];
  DWORD written = 0;
  DWORD pixel_bytes;
  HANDLE file;
  if (framebuffer == NULL) return;
  capture_attempts += 1;
  capture_error = 0;
  pixel_bytes = (DWORD)(pocket_legacy_runtime_width() * pocket_legacy_runtime_height() * 4U);
  memset(header, 0, sizeof(header));
  put_u16_le(header, 0, 0x4d42);
  put_u32_le(header, 2, (uint32_t)(sizeof(header) + pixel_bytes));
  put_u32_le(header, 10, (uint32_t)sizeof(header));
  put_u32_le(header, 14, 40);
  put_u32_le(header, 18, (uint32_t)pocket_legacy_runtime_width());
  put_u32_le(header, 22, (uint32_t)(-(int32_t)pocket_legacy_runtime_height()));
  put_u16_le(header, 26, 1);
  put_u16_le(header, 28, 32);
  put_u32_le(header, 34, pixel_bytes);
  file = CreateFileW(
    POCKET_FRAME_TEMP_PATH,
    GENERIC_WRITE,
    0,
    NULL,
    CREATE_ALWAYS,
    FILE_ATTRIBUTE_NORMAL,
    NULL
  );
  if (file == INVALID_HANDLE_VALUE) {
    capture_error = GetLastError();
    return;
  }
  if (!WriteFile(file, header, sizeof(header), &written, NULL) ||
      written != sizeof(header) ||
      !WriteFile(file, framebuffer, pixel_bytes, &written, NULL) ||
      written != pixel_bytes) {
    capture_error = GetLastError();
    CloseHandle(file);
    DeleteFileW(POCKET_FRAME_TEMP_PATH);
    return;
  }
  FlushFileBuffers(file);
  CloseHandle(file);
  DeleteFileW(POCKET_FRAME_PATH);
  if (!MoveFileW(POCKET_FRAME_TEMP_PATH, POCKET_FRAME_PATH)) {
    capture_error = GetLastError();
    DeleteFileW(POCKET_FRAME_TEMP_PATH);
    return;
  }
  capture_successes += 1;
}

static void physical_to_logical(HWND window, LPARAM position, int *x, int *y) {
  RECT client;
  int width;
  int height;
  GetClientRect(window, &client);
  width = client.right > client.left ? client.right - client.left : 1;
  height = client.bottom > client.top ? client.bottom - client.top : 1;
  *x = (int)((long)(short)LOWORD(position) * POCKET_LOGICAL_WIDTH / width);
  *y = (int)((long)(short)HIWORD(position) * POCKET_LOGICAL_HEIGHT / height);
  if (*x < 0) *x = 0;
  if (*y < 0) *y = 0;
  if (*x >= POCKET_LOGICAL_WIDTH) *x = POCKET_LOGICAL_WIDTH - 1;
  if (*y >= POCKET_LOGICAL_HEIGHT) *y = POCKET_LOGICAL_HEIGHT - 1;
}

static void render_frame(HWND window) {
  unsigned long action_sequence;
  int action_advanced;
  int delivered_touch;
  int bounds[4];
  RECT dirty;
  delivered_touch = touch_down;
  if (!pocket_legacy_runtime_frame_ticks(touch_down, touch_x, touch_y, touch_hit, 1)) {
    copy_error(pocket_legacy_runtime_error());
    write_status("failed");
    KillTimer(window, POCKET_TIMER_ID);
    InvalidateRect(window, NULL, FALSE);
    return;
  }
  framebuffer = pocket_legacy_runtime_render();
  frames += 1;
  if (delivered_touch) touch_was_sent = 1;
  if (touch_release_after_frame) {
    touch_down = 0;
    touch_hit = 0;
    touch_release_after_frame = 0;
  }
  action_sequence = pocket_legacy_runtime_action_sequence();
  action_advanced = action_sequence > observed_action_sequence;
  if (action_advanced) {
    observed_action_sequence = action_sequence;
    completed_touch_sequences += 1;
    capture_pending = 1;
  }
  if (pocket_legacy_runtime_damage_bounds(bounds)) {
    RECT client;
    GetClientRect(window, &client);
    dirty.left = bounds[0] * client.right / POCKET_LOGICAL_WIDTH;
    dirty.top = bounds[1] * client.bottom / POCKET_LOGICAL_HEIGHT;
    dirty.right = (bounds[2] * client.right + POCKET_LOGICAL_WIDTH - 1) /
      POCKET_LOGICAL_WIDTH;
    dirty.bottom = (bounds[3] * client.bottom + POCKET_LOGICAL_HEIGHT - 1) /
      POCKET_LOGICAL_HEIGHT;
    InvalidateRect(window, &dirty, FALSE);
  }
  if (frames == 1 || frames % 60 == 0 || action_advanced) {
    write_status("running");
  }
}

static void paint(HWND window) {
  PAINTSTRUCT paint;
  BITMAPINFO bitmap;
  RECT client;
  HDC dc = BeginPaint(window, &paint);
  GetClientRect(window, &client);
  if (framebuffer != NULL) {
    memset(&bitmap, 0, sizeof(bitmap));
    bitmap.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bitmap.bmiHeader.biWidth = (LONG)pocket_legacy_runtime_width();
    bitmap.bmiHeader.biHeight = -(LONG)pocket_legacy_runtime_height();
    bitmap.bmiHeader.biPlanes = 1;
    bitmap.bmiHeader.biBitCount = 32;
    bitmap.bmiHeader.biCompression = BI_RGB;
    if (SetDIBitsToDevice(
      dc,
      0,
      0,
      (DWORD)pocket_legacy_runtime_width(),
      (DWORD)pocket_legacy_runtime_height(),
      0,
      0,
      0,
      (UINT)pocket_legacy_runtime_height(),
      framebuffer,
      &bitmap,
      DIB_RGB_COLORS
    ) != 0) {
      gdi_composites += 1;
      if (capture_pending || gdi_composites == 1) {
        write_framebuffer_bmp();
        capture_pending = 0;
      }
    }
  } else {
    FillRect(dc, &client, (HBRUSH)GetStockObject(BLACK_BRUSH));
  }
  EndPaint(window, &paint);
}

static LRESULT CALLBACK window_proc(
  HWND window,
  UINT message,
  WPARAM word,
  LPARAM parameter
) {
  (void)word;
  switch (message) {
    case WM_TIMER:
      if (word == POCKET_TIMER_ID) render_frame(window);
      return 0;
    case WM_PAINT:
      paint(window);
      return 0;
    case WM_ERASEBKGND:
      return 1;
    case WM_KEYDOWN:
    case WM_SYSKEYDOWN:
      if (word == VK_HOME || word == VK_ESCAPE) {
        PostMessageW(window, WM_CLOSE, 0, 0);
        return 0;
      }
      return DefWindowProcW(window, message, word, parameter);
    case WM_LBUTTONDOWN:
      SetCapture(window);
      physical_to_logical(window, parameter, &touch_x, &touch_y);
      touch_down = 1;
      touch_hit = pocket_legacy_runtime_hit_test_bounds((float)touch_x, (float)touch_y);
      touch_was_sent = 0;
      touch_release_after_frame = 0;
      touch_sequences += 1;
      return 0;
    case WM_MOUSEMOVE:
      if (touch_down && !touch_release_after_frame) {
        physical_to_logical(window, parameter, &touch_x, &touch_y);
      }
      return 0;
    case WM_LBUTTONUP:
      if (!touch_down || touch_release_after_frame) return 0;
      physical_to_logical(window, parameter, &touch_x, &touch_y);
      if (touch_was_sent) {
        touch_down = 0;
        touch_hit = 0;
      } else {
        /* Keep a short tap alive until one 60 Hz guest frame sees it. */
        touch_release_after_frame = 1;
      }
      ReleaseCapture();
      return 0;
    case WM_CLOSE:
      DestroyWindow(window);
      return 0;
    case WM_DESTROY:
      KillTimer(window, POCKET_TIMER_ID);
      write_status("terminated");
      pocket_legacy_runtime_shutdown();
      PostQuitMessage(0);
      return 0;
    default:
      return DefWindowProcW(window, message, word, parameter);
  }
}

int WINAPI WinMain(
  HINSTANCE instance,
  HINSTANCE previous,
  LPWSTR command_line,
  int show
) {
  static const WCHAR class_name[] = L"PocketJSMeizuM8";
  WNDCLASSW window_class;
  MSG message;
  int screen_width;
  int screen_height;
  (void)previous;
  (void)command_line;
  (void)show;
  memset(&window_class, 0, sizeof(window_class));
  window_class.lpfnWndProc = window_proc;
  window_class.hInstance = instance;
  window_class.hCursor = LoadCursor(NULL, IDC_ARROW);
  window_class.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
  window_class.lpszClassName = class_name;
  if (!RegisterClassW(&window_class)) return 2;

  screen_width = GetSystemMetrics(SM_CXSCREEN);
  screen_height = GetSystemMetrics(SM_CYSCREEN);
  window_handle = CreateWindowW(
    class_name,
    L"PocketJS",
    WS_POPUP | WS_VISIBLE,
    0,
    0,
    screen_width,
    screen_height,
    NULL,
    NULL,
    instance,
    NULL
  );
  if (window_handle == NULL) return 3;
  SetWindowPos(
    window_handle,
    HWND_TOP,
    0,
    0,
    screen_width,
    screen_height,
    SWP_SHOWWINDOW
  );

  write_status("starting");
  if (!pocket_legacy_runtime_boot(
        (const char *)pocket_app_js,
        pocket_app_js_len,
        pocket_app_pak,
        pocket_app_pak_len,
        POCKET_LOGICAL_WIDTH,
        POCKET_LOGICAL_HEIGHT
      )) {
    WCHAR wide_error[512];
    copy_error(pocket_legacy_runtime_error());
    MultiByteToWideChar(CP_ACP, 0, runtime_error, -1, wide_error, 512);
    write_status("failed");
    MessageBoxW(window_handle, wide_error, L"PocketJS failed", MB_OK | MB_ICONERROR);
    DestroyWindow(window_handle);
    return 4;
  }
  if (SetTimer(window_handle, POCKET_TIMER_ID, POCKET_TIMER_MS, NULL) == 0) {
    copy_error("SetTimer failed");
    write_status("failed");
    DestroyWindow(window_handle);
    return 5;
  }
  render_frame(window_handle);
  ShowWindow(window_handle, SW_SHOW);
  UpdateWindow(window_handle);
  while (GetMessageW(&message, NULL, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  return (int)message.wParam;
}

/* KeyOS libc shim: assert reports through the host's abort path. */
#ifndef POCKET_KEYOS_ASSERT_H
#define POCKET_KEYOS_ASSERT_H

#ifdef __cplusplus
extern "C" {
#endif
_Noreturn void __pocket_keyos_assert(const char *expr, const char *file, int line);
#ifdef __cplusplus
}
#endif
#endif

#undef assert
#ifdef NDEBUG
#define assert(expr) ((void)0)
#else
#define assert(expr) ((expr) ? (void)0 : __pocket_keyos_assert(#expr, __FILE__, __LINE__))
#endif
#ifndef __cplusplus
#define static_assert _Static_assert
#endif

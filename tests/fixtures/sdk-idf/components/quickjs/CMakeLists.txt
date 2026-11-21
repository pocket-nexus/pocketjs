# The consumer supplies QuickJS source; this fixture never imports the old IDF
# component or its separate immutable-buffer source hash gate.
idf_component_register(SRCS "${POCKET_QUICKJS}/quickjs.c" "${POCKET_QUICKJS}/dtoa.c"
    "${POCKET_QUICKJS}/libregexp.c" "${POCKET_QUICKJS}/libunicode.c"
    INCLUDE_DIRS "${POCKET_QUICKJS}")
target_compile_definitions(${COMPONENT_LIB} PRIVATE _GNU_SOURCE QUICKJS_NG_BUILD)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-unused-parameter -Wno-sign-compare
    -Wno-unused-but-set-variable -Wno-maybe-uninitialized -Wno-type-limits
    -Wno-error=format -Wno-error=implicit-fallthrough
    -Wno-error=incompatible-pointer-types -fno-strict-aliasing)
# QuickJS uses int alongside int32_t. IDF's RISC-V libc typedefs int32_t as
# long; both are 32 bits in ilp32f. Keep vendor diagnostics in the build log
# and disable alias-based optimization for these upstream pointer accesses.

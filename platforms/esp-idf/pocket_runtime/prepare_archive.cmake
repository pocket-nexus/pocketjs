if(NOT DEFINED POCKETJS_ARCHIVE OR NOT DEFINED POCKETJS_ARCHIVER OR
   NOT DEFINED POCKETJS_TARGET)
    message(FATAL_ERROR
        "prepare_archive.cmake requires POCKETJS_ARCHIVE, POCKETJS_ARCHIVER, and POCKETJS_TARGET")
endif()

if(NOT POCKETJS_TARGET STREQUAL "esp32p4")
    return()
endif()

# Rust's generic riscv32 staticlib includes compiler-rt C objects built for the
# soft-float ABI. ESP-IDF's ESP32-P4 objects use ilp32f and already provide the
# same runtime symbols through ROM or libgcc. Keep Rust compiler_builtins and
# remove only those compiler-rt C members before exposing the archive to IDF.
execute_process(
    COMMAND "${POCKETJS_ARCHIVER}" t "${POCKETJS_ARCHIVE}"
    RESULT_VARIABLE list_result
    OUTPUT_VARIABLE archive_members
    ERROR_VARIABLE list_error
    OUTPUT_STRIP_TRAILING_WHITESPACE)
if(NOT list_result EQUAL 0)
    message(FATAL_ERROR
        "cannot inspect PocketJS native archive with ${POCKETJS_ARCHIVER}: ${list_error}")
endif()

string(REPLACE "\n" ";" archive_members "${archive_members}")
set(unresolved_members ${archive_members})
list(FILTER unresolved_members INCLUDE REGEX "^/[0-9]+$")
if(unresolved_members)
    message(FATAL_ERROR
        "${POCKETJS_ARCHIVER} does not resolve GNU archive long names; pass llvm-ar, GNU ar, or the ESP-IDF target archiver")
endif()

# compiler_builtins gives its compiler-rt C group one content-hash prefix.
# Anchor removal to two compiler-rt source names so another crate's native
# object group cannot be removed merely because it uses the same naming form.
set(compiler_rt_prefix "")
foreach(member IN LISTS archive_members)
    if(member MATCHES "^([0-9a-f]+)-(int_util|popcountsi2)[.]o$")
        set(compiler_rt_prefix "${CMAKE_MATCH_1}")
        break()
    endif()
endforeach()
if(NOT compiler_rt_prefix)
    return()
endif()
list(FILTER archive_members INCLUDE REGEX
    "^${compiler_rt_prefix}-[A-Za-z0-9_]+[.]o$")

execute_process(
    COMMAND "${POCKETJS_ARCHIVER}" d "${POCKETJS_ARCHIVE}" ${archive_members}
    RESULT_VARIABLE delete_result
    ERROR_VARIABLE delete_error)
if(NOT delete_result EQUAL 0)
    message(FATAL_ERROR
        "cannot prepare PocketJS native archive with ${POCKETJS_ARCHIVER}: ${delete_error}")
endif()
list(LENGTH archive_members removed_count)
message(STATUS
    "PocketJS removed ${removed_count} soft-float compiler-rt objects from the ESP32-P4 archive")

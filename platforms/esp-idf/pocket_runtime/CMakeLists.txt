# A Registry bundle advertises only archives it contains. Source builds use
# the supported Rust triples; the linker reports a missing override/archive.
set(pocket_runtime_targets)
if(POCKETJS_RUST_FROM_SOURCE OR POCKET_RUNTIME_ARCHIVE OR CMAKE_BUILD_EARLY_EXPANSION)
    set(pocket_runtime_targets esp32p4 esp32s3 esp32c3 esp32c6)
else()
    file(GLOB pocket_runtime_archives RELATIVE "${CMAKE_CURRENT_LIST_DIR}/lib"
        "${CMAKE_CURRENT_LIST_DIR}/lib/*/libpocket_idf_runtime.a")
    foreach(archive IN LISTS pocket_runtime_archives)
        get_filename_component(target "${archive}" DIRECTORY)
        list(APPEND pocket_runtime_targets "${target}")
    endforeach()
    if(NOT pocket_runtime_targets)
        message(FATAL_ERROR "PocketJS has no native archives; install a Registry bundle or set POCKETJS_RUST_FROM_SOURCE=ON")
    endif()
endif()
set(pocketjs_public_includes "include")
if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/include/pocket_drivers.h")
    list(APPEND pocketjs_public_includes "../../../contracts/generated")
endif()
idf_component_register(
    SRCS "src/hooks.c" "src/package_source.c"
    INCLUDE_DIRS ${pocketjs_public_includes}
    PRIV_REQUIRES heap log
    REQUIRED_IDF_TARGETS ${pocket_runtime_targets}
)

include("${CMAKE_CURRENT_LIST_DIR}/native_archive.cmake")
pocketjs_link_native("${CMAKE_CURRENT_LIST_DIR}" "runtime" "pocket_idf_runtime" "POCKET_RUNTIME_ARCHIVE")
target_link_options(${COMPONENT_LIB} INTERFACE
    "-Wl,--undefined=pocket_host_alloc"
    "-Wl,--undefined=pocket_host_realloc"
    "-Wl,--undefined=pocket_host_free"
    "-Wl,--undefined=pocket_host_panic"
    "-Wl,--undefined=pocket_host_log"
    "-Wl,--undefined=pocket_host_boot_stage")
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)

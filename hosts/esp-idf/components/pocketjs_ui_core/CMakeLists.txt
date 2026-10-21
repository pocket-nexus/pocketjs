idf_component_register(
    SRCS "src/ui_core.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES heap log
    REQUIRED_IDF_TARGETS esp32p4 esp32s3
)

include("${CMAKE_CURRENT_LIST_DIR}/native_archive.cmake")
pocketjs_link_native("${CMAKE_CURRENT_LIST_DIR}" "ui-core" "pocketjs_idf_ui_core" "POCKETJS_UI_CORE_ARCHIVE")
target_link_options(${COMPONENT_LIB} INTERFACE
    "-Wl,--undefined=pocket_host_alloc"
    "-Wl,--undefined=pocket_host_realloc"
    "-Wl,--undefined=pocket_host_free"
    "-Wl,--undefined=pocket_host_panic"
    "-Wl,--undefined=pocket_host_log"
    "-Wl,--undefined=pocket_host_boot_stage")
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)

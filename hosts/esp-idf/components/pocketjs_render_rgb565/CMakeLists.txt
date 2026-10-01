idf_component_register(
    SRCS "src/render_rgb565.c"
    INCLUDE_DIRS "include"
    REQUIRES pocketjs_ui_core
    REQUIRED_IDF_TARGETS esp32p4 esp32s3
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)

if(TARGET __idf_pocketjs_ui_core)
    idf_component_get_property(pocketjs_core_dir pocketjs_ui_core COMPONENT_DIR)
else()
    idf_component_get_property(pocketjs_core_dir pocket-nexus__pocketjs_ui_core COMPONENT_DIR)
endif()
include("${pocketjs_core_dir}/native_archive.cmake")
pocketjs_link_native("${CMAKE_CURRENT_LIST_DIR}" "render-rgb565" "pocketjs_idf_render_rgb565" "POCKETJS_RENDER_RGB565_ARCHIVE")

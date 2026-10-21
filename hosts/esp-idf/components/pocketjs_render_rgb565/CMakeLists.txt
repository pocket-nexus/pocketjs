idf_component_register(
    SRCS "src/render_rgb565.c"
    INCLUDE_DIRS "include"
    REQUIRES pocketjs_ui_core
    REQUIRED_IDF_TARGETS esp32p4 esp32s3
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)

# The UI component's single Rust archive also exports the renderer ABI.

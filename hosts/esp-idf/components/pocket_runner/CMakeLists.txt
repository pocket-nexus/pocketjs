idf_component_register(
    SRCS "src/runner.c"
    INCLUDE_DIRS "include"
    REQUIRES pocket_runtime
    PRIV_REQUIRES esp_timer freertos
    REQUIRED_IDF_TARGETS esp32p4 esp32s3
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)

# The stream's wire layout is shared with the 3DS product.
set(shared "${CMAKE_CURRENT_LIST_DIR}/../../../../engine/host-services")

idf_component_register(
    SRCS "src/media.c"
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "${shared}"
    REQUIRES pocket_runtime pocket_guest_quickjs
    PRIV_REQUIRES esp_timer log lwip
    REQUIRED_IDF_TARGETS esp32p4
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)

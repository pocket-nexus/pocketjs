set(pocketjs_ppa_includes "include")
if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/include/pocket/render_esp_ppa.h")
    list(APPEND pocketjs_ppa_includes "../../../platforms/esp-idf/render-ppa/include")
endif()
idf_component_register(
    SRCS
        "src/accelerator.c"
        "src/lanes.c"
        "src/pocketjs_ppa.c"
    INCLUDE_DIRS ${pocketjs_ppa_includes}
    PRIV_INCLUDE_DIRS "src"
    REQUIRES pocket_runtime esp_driver_ppa
    PRIV_REQUIRES log esp_mm freertos
    REQUIRED_IDF_TARGETS esp32p4
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)

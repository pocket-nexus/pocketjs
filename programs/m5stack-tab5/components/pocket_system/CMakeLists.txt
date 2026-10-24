# engine/host-services holds the link, launcher and data.fs state machines
# every native program compiles; this component adds the store, the radio
# and the QuickJS bindings.
set(shared "${CMAKE_CURRENT_LIST_DIR}/../../../../engine/host-services")

idf_component_register(
    SRCS
        "src/services_host.c"
        "src/wifi.c"
        "src/qjs.c"
        "${shared}/fs.c"
        "${shared}/jscan.c"
        "${shared}/launcher.c"
        "${shared}/link.c"
        "${shared}/link_proto.c"
        "${shared}/sha256.c"
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "src" "${shared}"
    REQUIRES pocket_runtime pocket_guest_quickjs
    PRIV_REQUIRES esp_event esp_netif esp_timer esp_wifi fatfs log lwip nvs_flash vfs wear_levelling
    REQUIRED_IDF_TARGETS esp32p4
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)

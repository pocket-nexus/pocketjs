set(pocket_prebuilt_requires pocket_runtime pocket_guest_quickjs)
if(IDF_TARGET STREQUAL "esp32p4")
    list(APPEND pocket_prebuilt_requires pocket_render_esp_ppa)
endif()
idf_component_register(
    SRCS "../../smoke/main/main.c" "../../common/sample_io.c"
    INCLUDE_DIRS "../../common"
    REQUIRES ${pocket_prebuilt_requires}
)
pocketjs_embed_package(
    TARGET ${COMPONENT_LIB}
    NAME smoke
    PACKAGE "../idf-smoke.pocket"
    HOST_PROFILE "../../smoke/pocket.host.json"
)

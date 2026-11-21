set(POCKETJS_PROFILE_EXPORT_DIR "" CACHE PATH "Existing pocket host export for offline bundle embedding")
set(pocketjs_smoke_requires pocket_runtime pocket_guest_quickjs)
if(IDF_TARGET STREQUAL "esp32p4")
    list(APPEND pocketjs_smoke_requires pocket_render_esp_ppa)
endif()

idf_component_register(
    SRCS "main.c" "../../common/sample_io.c"
    INCLUDE_DIRS "../../common"
    REQUIRES ${pocketjs_smoke_requires}
)

set(POCKETJS_SMOKE_PREBUILT_BUNDLE "" CACHE FILEPATH
    "Use an existing idf-smoke.pkb instead of invoking the PocketJS CLI")
if(NOT POCKETJS_SMOKE_PREBUILT_BUNDLE AND
   EXISTS "${CMAKE_CURRENT_LIST_DIR}/../idf-smoke.pkb")
    set(POCKETJS_SMOKE_PREBUILT_BUNDLE
        "${CMAKE_CURRENT_LIST_DIR}/../idf-smoke.pkb")
endif()
if(POCKETJS_SMOKE_PREBUILT_BUNDLE)
    pocketjs_embed_bundle(
        TARGET ${COMPONENT_LIB}
        NAME smoke
        BUNDLE "${POCKETJS_SMOKE_PREBUILT_BUNDLE}"
        PROFILE_EXPORT_DIR "${POCKETJS_PROFILE_EXPORT_DIR}")
else()
    pocketjs_compile_app(
        TARGET ${COMPONENT_LIB}
        NAME smoke
        HOST_CONFIG "../pocket.host.config.ts")
endif()

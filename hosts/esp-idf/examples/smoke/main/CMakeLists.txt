set(POCKETJS_PROFILE_EXPORT_DIR "" CACHE PATH "Existing pocket profile export for offline package embedding")
set(pocketjs_smoke_requires pocket_runtime pocket_guest_quickjs)
if(IDF_TARGET STREQUAL "esp32p4")
    list(APPEND pocketjs_smoke_requires pocket_render_esp_ppa)
endif()

idf_component_register(
    SRCS "main.c" "../../common/sample_io.c"
    INCLUDE_DIRS "../../common"
    REQUIRES ${pocketjs_smoke_requires}
)

set(POCKETJS_SMOKE_PREBUILT_PACKAGE "" CACHE FILEPATH
    "Use an existing idf-smoke.pocket instead of invoking the PocketJS CLI")
if(NOT POCKETJS_SMOKE_PREBUILT_PACKAGE AND
   EXISTS "${CMAKE_CURRENT_LIST_DIR}/../idf-smoke.pocket")
    set(POCKETJS_SMOKE_PREBUILT_PACKAGE
        "${CMAKE_CURRENT_LIST_DIR}/../idf-smoke.pocket")
endif()
if(POCKETJS_SMOKE_PREBUILT_PACKAGE)
    pocketjs_embed_package(
        TARGET ${COMPONENT_LIB}
        NAME smoke
        PACKAGE "${POCKETJS_SMOKE_PREBUILT_PACKAGE}"
        PROFILE_EXPORT_DIR "${POCKETJS_PROFILE_EXPORT_DIR}")
else()
    pocketjs_compile_app(
        TARGET ${COMPONENT_LIB}
        NAME smoke
        MANIFEST "../pocket.json"
        PROJECT_ROOT "..")
endif()

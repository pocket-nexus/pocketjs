set(POCKETJS_PROFILE_EXPORT_DIR "" CACHE PATH "Existing pocket host export for offline bundle embedding")
idf_component_register(
    SRCS "main.c" "../../common/sample_io.c"
    INCLUDE_DIRS "../../common"
    REQUIRES pocket_runtime pocket_guest_quickjs pocket_runner
)

set(POCKETJS_RUNNER_PREBUILT_BUNDLE "" CACHE FILEPATH "Prebuilt runner bundle")
if(NOT POCKETJS_RUNNER_PREBUILT_BUNDLE AND
   EXISTS "${CMAKE_CURRENT_LIST_DIR}/../../prebuilt/idf-smoke.pkb")
    set(POCKETJS_RUNNER_PREBUILT_BUNDLE "${CMAKE_CURRENT_LIST_DIR}/../../prebuilt/idf-smoke.pkb")
endif()
if(POCKETJS_RUNNER_PREBUILT_BUNDLE)
    pocketjs_embed_bundle(
        TARGET ${COMPONENT_LIB}
        NAME runner
        BUNDLE "${POCKETJS_RUNNER_PREBUILT_BUNDLE}"
        PROFILE_EXPORT_DIR "${POCKETJS_PROFILE_EXPORT_DIR}")
else()
    pocketjs_compile_app(
        TARGET ${COMPONENT_LIB}
        NAME runner
        HOST_CONFIG "../../smoke/pocket.host.config.ts")
endif()

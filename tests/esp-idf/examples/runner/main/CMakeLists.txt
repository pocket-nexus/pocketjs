set(POCKETJS_PROFILE_EXPORT_DIR "" CACHE PATH "Existing pocket host export for offline package embedding")
idf_component_register(
    SRCS "main.c" "../../common/sample_io.c"
    INCLUDE_DIRS "../../common"
    REQUIRES pocket_runtime pocket_guest_quickjs pocket_runner
)

set(POCKETJS_RUNNER_PREBUILT_PACKAGE "" CACHE FILEPATH "Prebuilt runner package")
if(NOT POCKETJS_RUNNER_PREBUILT_PACKAGE AND
   EXISTS "${CMAKE_CURRENT_LIST_DIR}/../../prebuilt/idf-smoke.pocket")
    set(POCKETJS_RUNNER_PREBUILT_PACKAGE "${CMAKE_CURRENT_LIST_DIR}/../../prebuilt/idf-smoke.pocket")
endif()
if(POCKETJS_RUNNER_PREBUILT_PACKAGE)
    pocketjs_embed_package(
        TARGET ${COMPONENT_LIB}
        NAME runner
        PACKAGE "${POCKETJS_RUNNER_PREBUILT_PACKAGE}"
        PROFILE_EXPORT_DIR "${POCKETJS_PROFILE_EXPORT_DIR}")
else()
    pocketjs_compile_app(
        TARGET ${COMPONENT_LIB}
        NAME runner
        MANIFEST "../../smoke/pocket.app.json"
        PROJECT_ROOT "../../smoke")
endif()

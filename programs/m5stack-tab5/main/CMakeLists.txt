set(POCKETJS_TAB5_APP "hero" CACHE STRING "Embedded app: hero, clear or home")
# The requirement list is read in the early expansion pass, before the cache
# holds the selected app, so every variant links the system component; only
# the home variant compiles it in (TAB5_LAUNCHER).
idf_component_register(
    SRCS "main.c" "tab5_camera_media.c" "tab5_keyboard.c"
    REQUIRES
        esp_driver_dma
        esp_driver_i2c
        esp_driver_ppa
        esp_lcd
        esp_mm
        esp_timer
        pocket_display_esp_dpi
        pocket_guest_quickjs
        pocket_render_esp_ppa
        pocket_runner
        pocket_runtime
        pocket_camera
        pocket_media
        pocket_system
)

if(POCKETJS_TAB5_APP STREQUAL "home")
    # Pocket Home is built in pocket-shell against home.runtime-config.ts.
    set(POCKETJS_TAB5_HOME_PACKAGE "" CACHE FILEPATH "Pocket Home's home-main.pocket")
    if(NOT POCKETJS_TAB5_HOME_PACKAGE)
        message(FATAL_ERROR "POCKETJS_TAB5_APP=home needs -DPOCKETJS_TAB5_HOME_PACKAGE=<home-main.pocket>")
    endif()
    pocketjs_embed_package(
        TARGET ${COMPONENT_LIB}
        NAME app
        PACKAGE "${POCKETJS_TAB5_HOME_PACKAGE}"
        RUNTIME_CONFIG "../home.runtime-config.ts")
    target_compile_definitions(${COMPONENT_LIB} PRIVATE TAB5_LAUNCHER=1)
else()
    pocketjs_compile_app(
        TARGET ${COMPONENT_LIB}
        NAME app
        MANIFEST "../../../apps/${POCKETJS_TAB5_APP}/pocket.tab5.json"
        RUNTIME_CONFIG "../${POCKETJS_TAB5_APP}.runtime-config.ts"
        PROJECT_ROOT "../../..")
endif()

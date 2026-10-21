cmake_minimum_required(VERSION 3.22)

set(pocketjs_components "../../../../platforms/esp-idf")
list(APPEND EXTRA_COMPONENT_DIRS
    "${pocketjs_components}/pocket_guest_quickjs"
    "${pocketjs_components}/pocket_runtime")
set(pocketjs_idf_target "${IDF_TARGET}")
if(NOT pocketjs_idf_target AND DEFINED ENV{IDF_TARGET})
    set(pocketjs_idf_target "$ENV{IDF_TARGET}")
endif()
if(pocketjs_idf_target STREQUAL "esp32p4")
    list(APPEND EXTRA_COMPONENT_DIRS "${pocketjs_components}/pocket_render_esp_ppa")
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
idf_build_set_property(MINIMAL_BUILD ON)
project(pocketjs_idf_prebuilt)

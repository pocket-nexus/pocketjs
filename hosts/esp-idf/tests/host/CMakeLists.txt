cmake_minimum_required(VERSION 3.20)
project(pocketjs_idf_host_tests C)
enable_testing()
get_filename_component(ROOT "${CMAKE_CURRENT_LIST_DIR}/../../../.." ABSOLUTE)
set(COMPONENTS "${ROOT}/hosts/esp-idf/components")
set(POCKETJS_QUICKJS_SOURCE "" CACHE PATH "QuickJS source directory from espressif/quickjs-ng 0.14.0")
set(POCKETJS_UI_CORE_ARCHIVE "${ROOT}/hosts/esp-idf/native/ui-core/target/release/libpocketjs_idf_ui_core.a" CACHE FILEPATH "Host-native no_std runtime archive")
set(POCKETJS_TEST_FIXTURES "${CMAKE_CURRENT_BINARY_DIR}" CACHE PATH "Generated PAK fixtures")
find_package(Python3 REQUIRED COMPONENTS Interpreter)
if(NOT EXISTS "${POCKETJS_QUICKJS_SOURCE}/quickjs.c")
    message(FATAL_ERROR "Pass POCKETJS_QUICKJS_SOURCE from the pinned IDF component")
endif()
set(preparer "${COMPONENTS}/pocketjs_guest/tools/prepare_quickjs.py")
execute_process(COMMAND "${Python3_EXECUTABLE}" "${preparer}"
    "${POCKETJS_QUICKJS_SOURCE}/quickjs.c" "${CMAKE_CURRENT_BINARY_DIR}/quickjs.c"
    COMMAND_ERROR_IS_FATAL ANY)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${preparer}" "${POCKETJS_QUICKJS_SOURCE}/quickjs.c")
add_library(quickjs STATIC "${CMAKE_CURRENT_BINARY_DIR}/quickjs.c"
    "${POCKETJS_QUICKJS_SOURCE}/dtoa.c" "${POCKETJS_QUICKJS_SOURCE}/libregexp.c"
    "${POCKETJS_QUICKJS_SOURCE}/libunicode.c" "${POCKETJS_QUICKJS_SOURCE}/quickjs-libc.c")
target_include_directories(quickjs PUBLIC "${POCKETJS_QUICKJS_SOURCE}")
target_compile_definitions(quickjs PRIVATE _GNU_SOURCE)
target_link_libraries(quickjs PUBLIC m pthread ${CMAKE_DL_LIBS})
add_executable(immutable immutable.c)
target_link_libraries(immutable PRIVATE quickjs)
add_test(NAME immutable COMMAND immutable)

add_library(idf_components STATIC
    "${COMPONENTS}/pocketjs_package/src/package.c"
    "${COMPONENTS}/pocketjs_guest/src/guest.c"
    "${COMPONENTS}/pocketjs_ui_core/src/ui_core.c"
    "${COMPONENTS}/pocketjs_ui_qjs/src/ui_qjs.c"
    "${COMPONENTS}/pocketjs_render_rgb565/src/render_rgb565.c")
target_include_directories(idf_components PUBLIC include)
foreach(component pocketjs_package pocketjs_guest pocketjs_ui_core pocketjs_ui_qjs pocketjs_render_rgb565)
    target_include_directories(idf_components PUBLIC "${COMPONENTS}/${component}/include")
endforeach()
target_compile_options(idf_components PRIVATE -Wall -Wextra -Werror)
target_compile_definitions(idf_components PRIVATE _GNU_SOURCE
    malloc=pocketjs_test_malloc calloc=pocketjs_test_calloc realloc=pocketjs_test_realloc strdup=pocketjs_test_strdup)
target_link_libraries(idf_components PUBLIC quickjs "${POCKETJS_UI_CORE_ARCHIVE}")
add_executable(runtime runtime.c alloc.c)
target_include_directories(runtime PRIVATE "${ROOT}/contracts/generated")
target_compile_definitions(runtime PRIVATE _GNU_SOURCE)
target_link_libraries(runtime PRIVATE idf_components)
add_test(NAME runtime COMMAND runtime "${POCKETJS_TEST_FIXTURES}/valid.pak" "${POCKETJS_TEST_FIXTURES}/invalid.pak")

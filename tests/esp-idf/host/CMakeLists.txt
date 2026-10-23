cmake_minimum_required(VERSION 3.20)
project(pocket_idf_host_tests C)
enable_testing()
get_filename_component(ROOT "${CMAKE_CURRENT_LIST_DIR}/../../.." ABSOLUTE)
set(COMPONENTS "${ROOT}/platforms/esp-idf")
set(POCKETJS_QUICKJS_SOURCE "" CACHE PATH "Official espressif/quickjs-ng 0.14.0 source")
set(POCKET_RUNTIME_ARCHIVE "" CACHE FILEPATH "Host-native no_std program archive")
find_package(Python3 REQUIRED COMPONENTS Interpreter)
set(preparer "${COMPONENTS}/pocket_guest_quickjs/tools/prepare_quickjs.py")
execute_process(COMMAND "${Python3_EXECUTABLE}" "${preparer}"
 "${POCKETJS_QUICKJS_SOURCE}/quickjs.c" "${CMAKE_CURRENT_BINARY_DIR}/quickjs.c" COMMAND_ERROR_IS_FATAL ANY)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${preparer}" "${POCKETJS_QUICKJS_SOURCE}/quickjs.c")
add_library(quickjs STATIC "${CMAKE_CURRENT_BINARY_DIR}/quickjs.c"
 "${POCKETJS_QUICKJS_SOURCE}/dtoa.c" "${POCKETJS_QUICKJS_SOURCE}/libregexp.c" "${POCKETJS_QUICKJS_SOURCE}/libunicode.c")
target_include_directories(quickjs PUBLIC "${POCKETJS_QUICKJS_SOURCE}")
target_compile_definitions(quickjs PRIVATE _GNU_SOURCE)
target_link_libraries(quickjs PUBLIC m pthread ${CMAKE_DL_LIBS})
add_executable(immutable immutable.c)
target_link_libraries(immutable PRIVATE quickjs)
add_test(NAME immutable COMMAND immutable)
add_library(idf_components STATIC
 "${COMPONENTS}/pocket_runtime/src/hooks.c"
 "${COMPONENTS}/pocket_runtime/src/package_source.c"
 "${COMPONENTS}/pocket_guest_quickjs/src/guest.c"
 "${ROOT}/engine/guest-quickjs/src/guest.c"
 "${ROOT}/tests/esp-idf/examples/common/sample_io.c")
target_include_directories(idf_components PUBLIC include "${ROOT}/contracts/generated"
 "${COMPONENTS}/pocket_runtime/include" "${COMPONENTS}/pocket_guest_quickjs/include"
 "${ROOT}/engine/guest-quickjs/include" "${ROOT}/engine/guest-quickjs/src" "${ROOT}/tests/esp-idf/examples/common")
target_compile_options(idf_components PRIVATE -Wall -Wextra -Werror)
target_compile_definitions(idf_components PRIVATE _GNU_SOURCE)
target_link_libraries(idf_components PUBLIC quickjs "${POCKET_RUNTIME_ARCHIVE}")
add_executable(runtime runtime.c alloc.c "${CMAKE_CURRENT_BINARY_DIR}/pocketjs_package_host.c")
target_include_directories(runtime PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
target_compile_definitions(runtime PRIVATE _GNU_SOURCE)
target_link_libraries(runtime PRIVATE idf_components)
add_test(NAME runtime COMMAND runtime)
add_executable(display display.c alloc.c "${COMPONENTS}/pocket_display_esp_lcd/src/display.c")
target_include_directories(display PRIVATE include "${ROOT}/contracts/generated" "${COMPONENTS}/pocket_display_esp_lcd/include")
target_compile_options(display PRIVATE -Wall -Wextra -Werror)
add_test(NAME display COMMAND display)

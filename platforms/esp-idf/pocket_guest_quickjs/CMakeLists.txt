set(pocket_guest_source "${CMAKE_CURRENT_LIST_DIR}/generated")
if(NOT EXISTS "${pocket_guest_source}/guest.c")
    set(pocket_guest_source "${CMAKE_CURRENT_LIST_DIR}/../../../engine/guest-quickjs/src")
    set(pocket_guest_headers "${CMAKE_CURRENT_LIST_DIR}/../../../engine/guest-quickjs/include")
else()
    set(pocket_guest_headers "${CMAKE_CURRENT_LIST_DIR}/include")
endif()
idf_component_register(
    SRCS "src/guest.c" "${pocket_guest_source}/guest.c"
    INCLUDE_DIRS "include" "${pocket_guest_headers}"
    PRIV_INCLUDE_DIRS "${pocket_guest_source}"
    REQUIRES pocket_runtime quickjs-ng
    PRIV_REQUIRES heap log
    REQUIRED_IDF_TARGETS esp32p4 esp32s3 esp32c3 esp32c6
)

target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)

if(NOT CMAKE_BUILD_EARLY_EXPANSION)
    if(TARGET __idf_espressif__quickjs-ng)
        set(qjs_component espressif__quickjs-ng)
    else()
        set(qjs_component quickjs-ng)
    endif()
    idf_component_get_property(qjs_dir ${qjs_component} COMPONENT_DIR)
    idf_component_get_property(qjs_lib ${qjs_component} COMPONENT_LIB)
    set(qjs_source "${qjs_dir}/quickjs-ng/quickjs.c")
    set(qjs_preparer "${CMAKE_CURRENT_LIST_DIR}/tools/prepare_quickjs.py")
    set(qjs_prepared "${CMAKE_CURRENT_BINARY_DIR}/quickjs/quickjs.c")
    execute_process(COMMAND "${PYTHON}" "${qjs_preparer}" "${qjs_source}" "${qjs_prepared}"
        RESULT_VARIABLE prepare_result)
    if(NOT prepare_result EQUAL 0)
        message(FATAL_ERROR "QuickJS immutable-buffer preparation failed")
    endif()
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${qjs_source}" "${qjs_preparer}")
    get_target_property(qjs_sources ${qjs_lib} SOURCES)
    list(FILTER qjs_sources EXCLUDE REGEX "(^|/)quickjs[.]c$")
    set_property(TARGET ${qjs_lib} PROPERTY SOURCES ${qjs_sources} "${qjs_prepared}")
    get_source_file_property(qjs_options "${qjs_source}" DIRECTORY "${qjs_dir}" COMPILE_OPTIONS)
    if(qjs_options)
        set_source_files_properties("${qjs_prepared}" DIRECTORY "${qjs_dir}" PROPERTIES COMPILE_OPTIONS "${qjs_options}")
    endif()
endif()

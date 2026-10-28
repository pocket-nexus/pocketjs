include_guard(GLOBAL)

set(POCKETJS_PACKAGE_COMPONENT_DIR "${CMAKE_CURRENT_LIST_DIR}")
set(POCKETJS_PACKAGE_EMBED_TOOL "${POCKETJS_PACKAGE_COMPONENT_DIR}/tools/embed_package.py")
# pocket_profile.h includes pocket_runtime.h. A staged component carries it in
# include/; a checkout reads contracts/generated.
if(EXISTS "${POCKETJS_PACKAGE_COMPONENT_DIR}/include/pocket_runtime.h")
    set(POCKETJS_RUNTIME_HEADERS "${POCKETJS_PACKAGE_COMPONENT_DIR}/include")
else()
    get_filename_component(POCKETJS_RUNTIME_HEADERS
        "${POCKETJS_PACKAGE_COMPONENT_DIR}/../../../contracts/generated" ABSOLUTE)
endif()

function(_pocketjs_package_python out)
    if(DEFINED PYTHON AND EXISTS "${PYTHON}")
        set(${out} "${PYTHON}" PARENT_SCOPE)
        return()
    endif()
    find_program(pocketjs_python NAMES python3 python REQUIRED)
    set(${out} "${pocketjs_python}" PARENT_SCOPE)
endfunction()

function(_pocketjs_profile_paths name runtime_config export_dir config_out directory_out)
    if(NOT "${name}" MATCHES "^[a-z][a-z0-9_]*$")
        message(FATAL_ERROR "PocketJS NAME must match [a-z][a-z0-9_]*")
    endif()
    if(NOT runtime_config)
        set(runtime_config "${CMAKE_SOURCE_DIR}/pocket.runtime-config.ts")
    endif()
    get_filename_component(config "${runtime_config}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
    if(NOT export_dir)
        set(export_dir "${CMAKE_CURRENT_BINARY_DIR}/pocketjs/${name}/profile")
    endif()
    get_filename_component(directory "${export_dir}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
    set(${config_out} "${config}" PARENT_SCOPE)
    set(${directory_out} "${directory}" PARENT_SCOPE)
endfunction()

function(_pocketjs_require_target target)
    if(NOT TARGET "${target}")
        message(FATAL_ERROR "PocketJS target '${target}' does not exist")
    endif()
endfunction()

function(pocketjs_profile_header)
    cmake_parse_arguments(APP "" "TARGET;NAME;RUNTIME_CONFIG;PROFILE_EXPORT_DIR" "DEPENDS" ${ARGN})
    if(APP_UNPARSED_ARGUMENTS)
        message(FATAL_ERROR "Unknown pocketjs_profile_header arguments: ${APP_UNPARSED_ARGUMENTS}")
    endif()
    foreach(required TARGET NAME)
        if(NOT APP_${required})
            message(FATAL_ERROR "pocketjs_profile_header requires ${required}")
        endif()
    endforeach()
    _pocketjs_require_target("${APP_TARGET}")
    _pocketjs_profile_paths("${APP_NAME}" "${APP_RUNTIME_CONFIG}" "${APP_PROFILE_EXPORT_DIR}" config directory)
    if(NOT EXISTS "${config}")
        message(FATAL_ERROR "PocketJS runtime config does not exist: ${config}")
    endif()
    find_program(POCKETJS_CLI NAMES pocket REQUIRED)
    # One export command per output directory, even when several targets use it.
    string(SHA256 export_id "${directory}")
    get_property(previous_config GLOBAL PROPERTY "POCKETJS_PROFILE_${export_id}")
    if(previous_config AND NOT "${previous_config}" STREQUAL "${config}")
        message(FATAL_ERROR "PocketJS profile export directory is shared by different runtime configs: ${directory}")
    endif()
    if(NOT previous_config)
        add_custom_command(
            OUTPUT "${directory}/pocket_profile.h" "${directory}/pocket-profile.json"
            COMMAND "${CMAKE_COMMAND}" -E make_directory "${directory}"
            COMMAND "${POCKETJS_CLI}" profile export --config "${config}"
                --out "${directory}" --depfile "${directory}/pocket-profile.d"
            DEPFILE "${directory}/pocket-profile.d"
            DEPENDS "${config}" "${POCKETJS_CLI}" ${APP_DEPENDS}
            VERBATIM)
        add_custom_target("pocketjs_profile_${export_id}"
            DEPENDS "${directory}/pocket_profile.h" "${directory}/pocket-profile.json")
        set_property(GLOBAL PROPERTY "POCKETJS_PROFILE_${export_id}" "${config}")
    endif()
    add_dependencies("${APP_TARGET}" "pocketjs_profile_${export_id}")
    target_include_directories("${APP_TARGET}" PUBLIC "${directory}" "${POCKETJS_RUNTIME_HEADERS}")
endfunction()

function(_pocketjs_package_attach target name package profile_directory)
    _pocketjs_require_target("${target}")
    _pocketjs_package_python(python)
    set(generated "${CMAKE_CURRENT_BINARY_DIR}/pocketjs/${name}")
    set(stem "pocketjs_package_${name}")
    add_custom_command(
        OUTPUT "${generated}/${stem}.h" "${generated}/${stem}.c" "${generated}/${stem}.S"
        COMMAND "${python}" "${POCKETJS_PACKAGE_EMBED_TOOL}"
            "--package=${package}" "--profile=${profile_directory}/pocket-profile.json"
            "--name=${name}" "--output-dir=${generated}"
        DEPENDS "${package}" "${profile_directory}/pocket-profile.json"
            "${profile_directory}/pocket_profile.h" "${POCKETJS_PACKAGE_EMBED_TOOL}"
            "${POCKETJS_PACKAGE_COMPONENT_DIR}/tools/package_format.py"
        VERBATIM)
    string(MAKE_C_IDENTIFIER "${target}_${name}" generated_suffix)
    add_custom_target("pocketjs_${generated_suffix}_package"
        DEPENDS "${generated}/${stem}.h" "${generated}/${stem}.c" "${generated}/${stem}.S")
    add_dependencies("${target}" "pocketjs_${generated_suffix}_package")
    target_sources("${target}" PRIVATE "${generated}/${stem}.c" "${generated}/${stem}.S")
    target_include_directories("${target}" PUBLIC "${generated}" "${profile_directory}" "${POCKETJS_RUNTIME_HEADERS}")
endfunction()

function(pocketjs_embed_package)
    cmake_parse_arguments(APP "" "TARGET;NAME;PACKAGE;RUNTIME_CONFIG;PROFILE_EXPORT_DIR" "" ${ARGN})
    if(APP_UNPARSED_ARGUMENTS)
        message(FATAL_ERROR "Unknown pocketjs_embed_package arguments: ${APP_UNPARSED_ARGUMENTS}")
    endif()
    foreach(required TARGET NAME PACKAGE)
        if(NOT APP_${required})
            message(FATAL_ERROR "pocketjs_embed_package requires ${required}")
        endif()
    endforeach()
    get_filename_component(package "${APP_PACKAGE}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
    _pocketjs_profile_paths("${APP_NAME}" "${APP_RUNTIME_CONFIG}" "${APP_PROFILE_EXPORT_DIR}" config directory)
    if(NOT EXISTS "${package}")
        message(FATAL_ERROR "PocketJS package does not exist: ${package}")
    endif()
    # A checkout with the CLI on PATH exports a missing profile here, at
    # configure time; an offline build brings the export.
    if(NOT EXISTS "${directory}/pocket_profile.h" OR NOT EXISTS "${directory}/pocket-profile.json")
        find_program(POCKETJS_CLI NAMES pocket)
        if(POCKETJS_CLI AND EXISTS "${config}")
            execute_process(COMMAND "${POCKETJS_CLI}" profile export --config "${config}" --out "${directory}"
                RESULT_VARIABLE export_result OUTPUT_QUIET ERROR_VARIABLE export_error)
            if(NOT export_result EQUAL 0)
                message(FATAL_ERROR "PocketJS profile export failed: ${export_error}")
            endif()
            set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${config}")
        endif()
    endif()
    foreach(file pocket_profile.h pocket-profile.json)
        if(NOT EXISTS "${directory}/${file}")
            message(FATAL_ERROR "Missing ${directory}/${file}. Export it before this offline build: pocket profile export --config \"${config}\" --out \"${directory}\"")
        endif()
    endforeach()
    # Offline path: no CLI lookup or TypeScript evaluation, only exported artifacts.
    _pocketjs_package_attach("${APP_TARGET}" "${APP_NAME}" "${package}" "${directory}")
endfunction()

function(pocketjs_compile_app)
    cmake_parse_arguments(APP "" "TARGET;NAME;MANIFEST;RUNTIME_CONFIG;PROFILE_EXPORT_DIR;PROJECT_ROOT;COMPILER_RECEIPT" "DEPENDS" ${ARGN})
    if(APP_UNPARSED_ARGUMENTS)
        message(FATAL_ERROR "Unknown pocketjs_compile_app arguments: ${APP_UNPARSED_ARGUMENTS}")
    endif()
    foreach(required TARGET NAME MANIFEST)
        if(NOT APP_${required})
            message(FATAL_ERROR "pocketjs_compile_app requires ${required}")
        endif()
    endforeach()
    _pocketjs_profile_paths("${APP_NAME}" "${APP_RUNTIME_CONFIG}" "${APP_PROFILE_EXPORT_DIR}" config directory)
    pocketjs_profile_header(TARGET "${APP_TARGET}" NAME "${APP_NAME}"
        RUNTIME_CONFIG "${config}" PROFILE_EXPORT_DIR "${directory}" DEPENDS ${APP_DEPENDS})
    find_program(POCKETJS_CLI NAMES pocket REQUIRED)
    get_filename_component(manifest "${APP_MANIFEST}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
    if(APP_PROJECT_ROOT)
        get_filename_component(project_root "${APP_PROJECT_ROOT}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
    else()
        get_filename_component(project_root "${manifest}" DIRECTORY)
    endif()
    set(generated "${CMAKE_CURRENT_BINARY_DIR}/pocketjs/${APP_NAME}")
    set(package "${generated}/${APP_NAME}.pocket")
    set(dependencies "${generated}/${APP_NAME}.d")
    set(compiler_args)
    set(compiler_receipt)
    if(APP_COMPILER_RECEIPT)
        get_filename_component(compiler_receipt "${APP_COMPILER_RECEIPT}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
        list(APPEND compiler_args --compiler-receipt "${compiler_receipt}")
    endif()
    add_custom_command(
        OUTPUT "${package}"
        COMMAND "${CMAKE_COMMAND}" -E make_directory "${generated}"
        COMMAND "${POCKETJS_CLI}" compile
            --manifest "${manifest}" --runtime-config "${config}"
            --project-root "${project_root}" --outdir "${generated}"
            --plan-dir "${generated}/plans" --output "${package}" --depfile "${dependencies}"
            ${compiler_args}
        DEPFILE "${dependencies}"
        DEPENDS "${manifest}" "${config}" "${POCKETJS_CLI}" ${compiler_receipt} ${APP_DEPENDS}
        VERBATIM)
    _pocketjs_package_attach("${APP_TARGET}" "${APP_NAME}" "${package}" "${directory}")
endfunction()

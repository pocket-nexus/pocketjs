# Shared build policy; each component owns its archive and vendored sources.
function(pocketjs_link_native component_dir crate archive override)
    set(POCKETJS_RUST_FROM_SOURCE OFF CACHE BOOL "Build native archives with the developer's Rust toolchain")
    set(${override} "" CACHE FILEPATH "Override this component's native archive")
    if(IDF_TARGET STREQUAL "esp32p4")
        set(rust_target "riscv32imafc-unknown-none-elf")
    elseif(IDF_TARGET STREQUAL "esp32s3")
        set(rust_target "xtensa-esp32s3-none-elf")
    else()
        message(FATAL_ERROR "PocketJS supports esp32p4 and esp32s3")
    endif()
    if(POCKETJS_RUST_FROM_SOURCE)
        find_program(POCKETJS_CARGO cargo REQUIRED)
        get_filename_component(cargo_dir "${POCKETJS_CARGO}" DIRECTORY)
        find_program(POCKETJS_RUSTC rustc HINTS "${cargo_dir}" NO_DEFAULT_PATH REQUIRED)
        if(EXISTS "${component_dir}/vendor/native/Cargo.toml")
            set(native_root "${component_dir}/vendor/native")
            set(source_roots "${component_dir}/vendor/core" "${component_dir}/vendor/abi"
                "${component_dir}/vendor/runtime" "${component_dir}/vendor/renderer"
                "${component_dir}/vendor/spec" "${component_dir}/vendor/drivers")
        else()
            set(native_root "${component_dir}/../../native/${crate}")
            set(source_roots "${component_dir}/../../native/abi" "${component_dir}/../../native/runtime"
                "${component_dir}/../../../../engine/core" "${component_dir}/../../../../engine/spec"
                "${component_dir}/../../../../engine/drivers")
            if(crate STREQUAL "render-rgb565")
                list(APPEND source_roots "${component_dir}/../../../../engine/backends/rgb565")
            endif()
        endif()
        set(source_patterns "${native_root}/src/*.rs" "${native_root}/Cargo.toml" "${native_root}/Cargo.lock")
        foreach(source_root IN LISTS source_roots)
            list(APPEND source_patterns "${source_root}/src/*.rs" "${source_root}/Cargo.toml")
        endforeach()
        file(GLOB_RECURSE native_sources CONFIGURE_DEPENDS ${source_patterns})
        set(wrapper_source "${CMAKE_CURRENT_FUNCTION_LIST_DIR}/rustc_wrapper.rs")
        file(SHA256 "${wrapper_source}" wrapper_hash)
        string(SUBSTRING "${wrapper_hash}" 0 16 wrapper_key)
        set(cargo_target "${CMAKE_CURRENT_BINARY_DIR}/cargo/${wrapper_key}")
        set(wrapper "${CMAKE_CURRENT_BINARY_DIR}/rustc-wrapper-${wrapper_key}")
        set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${wrapper_source}")
        if(CMAKE_HOST_WIN32)
            string(APPEND wrapper ".exe")
        endif()
        execute_process(COMMAND "${POCKETJS_RUSTC}" --edition=2021 "${wrapper_source}" -o "${wrapper}"
            COMMAND_ERROR_IS_FATAL ANY)
        set(raw_archive "${cargo_target}/${rust_target}/release/lib${archive}.a")
        set(native_archive "${cargo_target}/prepared/${rust_target}/lib${archive}.a")
        set(prepare "${CMAKE_CURRENT_FUNCTION_LIST_DIR}/prepare_archive.cmake")
        set(unstable)
        if(IDF_TARGET STREQUAL "esp32s3")
            list(APPEND unstable "-Zbuild-std=core,alloc")
        endif()
        add_custom_command(OUTPUT "${native_archive}"
            COMMAND "${CMAKE_COMMAND}" -E env "CARGO_TARGET_DIR=${cargo_target}" "RUSTC=${POCKETJS_RUSTC}"
                "CARGO_ENCODED_RUSTFLAGS=" "RUSTFLAGS=" "RUSTC_WRAPPER=${wrapper}"
                "POCKETJS_RUST_NAMESPACE=${archive}"
                "${POCKETJS_CARGO}" build ${unstable} --release --locked --no-default-features
                --target "${rust_target}" --manifest-path "${native_root}/Cargo.toml"
            COMMAND "${CMAKE_COMMAND}" -E make_directory "${cargo_target}/prepared/${rust_target}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${raw_archive}" "${native_archive}"
            COMMAND "${CMAKE_COMMAND}" "-DPOCKETJS_ARCHIVE=${native_archive}"
                "-DPOCKETJS_ARCHIVER=${CMAKE_AR}" "-DPOCKETJS_TARGET=${IDF_TARGET}" -P "${prepare}"
            DEPENDS ${native_sources} "${prepare}" "${wrapper_source}" "${CMAKE_CURRENT_FUNCTION_LIST_FILE}"
            VERBATIM)
        add_custom_target(${archive}_build DEPENDS "${native_archive}")
    else()
        if(${override})
            get_filename_component(native_archive "${${override}}" ABSOLUTE)
        else()
            set(native_archive "${component_dir}/lib/${IDF_TARGET}/lib${archive}.a")
        endif()
        if(NOT EXISTS "${native_archive}")
            message(FATAL_ERROR "Missing ${archive} for ${IDF_TARGET}; install Registry archives or enable POCKETJS_RUST_FROM_SOURCE")
        endif()
    endif()
    add_library(${archive}_native STATIC IMPORTED GLOBAL)
    set_target_properties(${archive}_native PROPERTIES IMPORTED_LOCATION "${native_archive}")
    if(POCKETJS_RUST_FROM_SOURCE)
        add_dependencies(${archive}_native ${archive}_build)
    endif()
    target_link_libraries(${COMPONENT_LIB} PUBLIC ${archive}_native)
endfunction()

# The runtime component owns the one program archive and its source dependencies.
function(pocketjs_link_native component_dir crate archive override)
    set(POCKETJS_RUST_FROM_SOURCE OFF CACHE BOOL "Build native archives with the developer's Rust toolchain")
    set(${override} "" CACHE FILEPATH "Override this component's native archive")
    if(IDF_TARGET STREQUAL "esp32p4")
        set(rust_target "riscv32imafc-unknown-none-elf")
    elseif(IDF_TARGET STREQUAL "esp32s3")
        set(rust_target "xtensa-esp32s3-none-elf")
    elseif(IDF_TARGET STREQUAL "esp32c3")
        set(rust_target "riscv32imc-unknown-none-elf")
    elseif(IDF_TARGET STREQUAL "esp32c6")
        set(rust_target "riscv32imac-unknown-none-elf")
    else()
        message(FATAL_ERROR "PocketJS has no Rust triple for ${IDF_TARGET}")
    endif()
    if(POCKETJS_RUST_FROM_SOURCE)
        find_program(POCKETJS_CARGO cargo REQUIRED)
        get_filename_component(cargo_dir "${POCKETJS_CARGO}" DIRECTORY)
        find_program(POCKETJS_RUSTC rustc HINTS "${cargo_dir}" NO_DEFAULT_PATH REQUIRED)
        find_package(Python3 REQUIRED COMPONENTS Interpreter)
        if(EXISTS "${component_dir}/vendor/native/Cargo.toml")
            set(native_root "${component_dir}/vendor/native")
            set(cargo_cwd "${component_dir}/vendor")
            # Registry sources and local packages are the cargo-vendored closure.
            file(GLOB_RECURSE native_sources CONFIGURE_DEPENDS
                "${component_dir}/vendor/*" "${component_dir}/vendor/.cargo/*")
        else()
            set(native_root "${component_dir}/../../../hosts/esp-idf/native/${crate}")
            set(cargo_cwd "${native_root}")
            execute_process(COMMAND "${Python3_EXECUTABLE}"
                "${component_dir}/tools/native_sources.py" --cargo "${POCKETJS_CARGO}"
                --manifest "${native_root}/Cargo.toml" --target "${rust_target}"
                RESULT_VARIABLE metadata_result OUTPUT_VARIABLE source_patterns ERROR_VARIABLE metadata_error
                OUTPUT_STRIP_TRAILING_WHITESPACE)
            if(NOT metadata_result EQUAL 0)
                message(FATAL_ERROR "Cannot resolve PocketJS program dependencies: ${metadata_error}")
            endif()
            string(REPLACE "\n" ";" source_patterns "${source_patterns}")
            file(GLOB_RECURSE native_sources CONFIGURE_DEPENDS ${source_patterns})
        endif()
        foreach(source IN LISTS native_sources)
            if(source MATCHES "/Cargo\\.toml$")
                set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${source}")
            endif()
        endforeach()
        set(cargo_target "${CMAKE_CURRENT_BINARY_DIR}/cargo")
        set(raw_archive "${cargo_target}/${rust_target}/release/lib${archive}.a")
        set(native_archive "${cargo_target}/prepared/${rust_target}/lib${archive}.a")
        set(prepare "${CMAKE_CURRENT_FUNCTION_LIST_DIR}/prepare_archive.cmake")
        set(unstable)
        if(IDF_TARGET STREQUAL "esp32s3")
            list(APPEND unstable "-Zbuild-std=core,alloc")
        endif()
        add_custom_command(OUTPUT "${native_archive}"
            COMMAND "${CMAKE_COMMAND}" -E env "CARGO_TARGET_DIR=${cargo_target}" "RUSTC=${POCKETJS_RUSTC}"
                "CARGO_ENCODED_RUSTFLAGS=" "RUSTFLAGS=" "RUSTC_WRAPPER=" "RUSTC_WORKSPACE_WRAPPER="
                "CARGO_PROFILE_RELEASE_PANIC=abort" "CARGO_PROFILE_RELEASE_LTO=false"
                "CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16" "CARGO_PROFILE_RELEASE_OPT_LEVEL=3"
                "${POCKETJS_CARGO}" build ${unstable} --release --locked --no-default-features
                --target "${rust_target}" --manifest-path "${native_root}/Cargo.toml"
            COMMAND "${CMAKE_COMMAND}" -E make_directory "${cargo_target}/prepared/${rust_target}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${raw_archive}" "${native_archive}"
            COMMAND "${CMAKE_COMMAND}" "-DPOCKETJS_ARCHIVE=${native_archive}"
                "-DPOCKETJS_ARCHIVER=${CMAKE_AR}" "-DPOCKETJS_TARGET=${IDF_TARGET}" -P "${prepare}"
            WORKING_DIRECTORY "${cargo_cwd}"
            DEPENDS "${component_dir}/tools/native_sources.py" ${native_sources} "${prepare}" "${CMAKE_CURRENT_FUNCTION_LIST_FILE}"
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

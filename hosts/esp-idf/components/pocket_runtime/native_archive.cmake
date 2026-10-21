# The runtime component owns the one program archive and its source dependencies.
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
            set(source_roots "${component_dir}/vendor/core"
                "${component_dir}/vendor/runtime" "${component_dir}/vendor/runtime-cabi"
                "${component_dir}/vendor/render-ppa" "${component_dir}/vendor/pocket-gles"
                "${component_dir}/vendor/pocket-gles1" "${component_dir}/vendor/pocket-gles2"
                "${component_dir}/vendor/spec" "${component_dir}/vendor/drivers"
                "${component_dir}/vendor/raster" "${component_dir}/vendor/present"
                "${component_dir}/vendor/package" "${component_dir}/vendor/modules/media"
                "${component_dir}/vendor/render/draw-ops" "${component_dir}/vendor/render/glyph-pages"
                "${component_dir}/vendor/render/tri-batch" "${component_dir}/vendor/render/tex-cache")
        else()
            set(native_root "${component_dir}/../../native/${crate}")
            set(source_roots "${component_dir}/../../../../engine/runtime"
                "${component_dir}/../../../../engine/runtime-cabi"
                "${component_dir}/../../../../platforms/esp-idf/render-ppa"
                "${component_dir}/../../../../devices/gles/pocket-gles"
                "${component_dir}/../../../../devices/gles/pocket-gles1"
                "${component_dir}/../../../../devices/gles/pocket-gles2"
                "${component_dir}/../../../../engine/core" "${component_dir}/../../../../engine/spec"
                "${component_dir}/../../../../engine/drivers" "${component_dir}/../../../../engine/raster"
                "${component_dir}/../../../../engine/present" "${component_dir}/../../../../engine/package"
                "${component_dir}/../../../../engine/modules/media"
                "${component_dir}/../../../../engine/render/draw-ops"
                "${component_dir}/../../../../engine/render/glyph-pages"
                "${component_dir}/../../../../engine/render/tri-batch"
                "${component_dir}/../../../../engine/render/tex-cache")
        endif()
        set(source_patterns "${native_root}/src/*.rs" "${native_root}/Cargo.toml" "${native_root}/Cargo.lock")
        foreach(source_root IN LISTS source_roots)
            list(APPEND source_patterns "${source_root}/src/*.rs" "${source_root}/Cargo.toml")
        endforeach()
        file(GLOB_RECURSE native_sources CONFIGURE_DEPENDS ${source_patterns})
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
                "${POCKETJS_CARGO}" build ${unstable} --release --locked --no-default-features
                --target "${rust_target}" --manifest-path "${native_root}/Cargo.toml"
            COMMAND "${CMAKE_COMMAND}" -E make_directory "${cargo_target}/prepared/${rust_target}"
            COMMAND "${CMAKE_COMMAND}" -E copy "${raw_archive}" "${native_archive}"
            COMMAND "${CMAKE_COMMAND}" "-DPOCKETJS_ARCHIVE=${native_archive}"
                "-DPOCKETJS_ARCHIVER=${CMAKE_AR}" "-DPOCKETJS_TARGET=${IDF_TARGET}" -P "${prepare}"
            DEPENDS ${native_sources} "${prepare}" "${CMAKE_CURRENT_FUNCTION_LIST_FILE}"
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

idf_component_register(SRCS "main.c" "../consumer.c" "../renderer.c" "../hooks.c"
    "${POCKET_SDK}/src/guest-quickjs/guest.c"
    INCLUDE_DIRS ".." "${POCKET_SDK}/include/pocket"
    REQUIRES quickjs esp_driver_ppa heap)
find_package(Pocket REQUIRED CONFIG PATHS "${POCKET_SDK}/lib/cmake/Pocket" NO_DEFAULT_PATH)
target_link_libraries(${COMPONENT_LIB} PUBLIC Pocket::runtime)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)

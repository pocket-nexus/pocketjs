idf_component_register(SRCS "src/input.c" INCLUDE_DIRS "include" REQUIRES pocket_runtime esp_driver_gpio esp_adc esp_timer)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)

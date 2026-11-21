cmake_minimum_required(VERSION 3.16)
get_filename_component(pocket_root "${CMAKE_CURRENT_LIST_DIR}/../../../.." ABSOLUTE)
set(EXTRA_COMPONENT_DIRS
  "${pocket_root}/platforms/esp-idf/pocket_runtime"
  "${pocket_root}/platforms/esp-idf/pocket_input_touch"
  "${pocket_root}/platforms/esp-idf/pocket_input_gpio")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(pocket_input_firmware)

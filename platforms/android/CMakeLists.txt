cmake_minimum_required(VERSION 3.20)
project(pocket_android LANGUAGES C)

get_filename_component(POCKET_FRAMEWORK_ROOT "${CMAKE_CURRENT_LIST_DIR}/../.." ABSOLUTE)
find_package(Threads REQUIRED)
add_library(pocket_android_input STATIC
  src/input.c
  "${POCKET_FRAMEWORK_ROOT}/engine/runtime/compat/input.c")
add_library(pocket::android_input ALIAS pocket_android_input)
target_compile_features(pocket_android_input PUBLIC c_std_11)
target_include_directories(pocket_android_input PUBLIC
  "${CMAKE_CURRENT_LIST_DIR}/include"
  "${POCKET_FRAMEWORK_ROOT}/contracts/generated")
target_include_directories(pocket_android_input PRIVATE
  "${POCKET_FRAMEWORK_ROOT}/engine/runtime/include")
target_link_libraries(pocket_android_input PUBLIC Threads::Threads m)
set_target_properties(pocket_android_input PROPERTIES POSITION_INDEPENDENT_CODE ON)

# NDK supplies JNI in its sysroot. Host JNI is opt-in and uses an installed
# JDK, or an explicit real JNI include directory for API conformance builds.
option(POCKET_ANDROID_JNI "Build the JNI owned-byte-array bridge" ${ANDROID})
set(POCKET_ANDROID_JNI_INCLUDE_DIR "" CACHE PATH "Explicit real JNI header directory (optional)")
if(POCKET_ANDROID_JNI)
  add_library(pocket_android_jni STATIC src/jni.c)
  add_library(pocket::android_jni ALIAS pocket_android_jni)
  target_compile_features(pocket_android_jni PUBLIC c_std_11)
  target_include_directories(pocket_android_jni PUBLIC "${CMAKE_CURRENT_LIST_DIR}/include")
  if(POCKET_ANDROID_JNI_INCLUDE_DIR)
    target_include_directories(pocket_android_jni PUBLIC "${POCKET_ANDROID_JNI_INCLUDE_DIR}")
  elseif(NOT ANDROID)
    find_package(JNI REQUIRED)
    target_include_directories(pocket_android_jni PUBLIC ${JNI_INCLUDE_DIRS})
  endif()
  set_target_properties(pocket_android_jni PROPERTIES POSITION_INDEPENDENT_CODE ON)
endif()

# Android log is a platform library. Host input/JNI consumers do not need it.
if(ANDROID)
  find_library(POCKET_ANDROID_LOG_LIBRARY log REQUIRED)
  add_library(pocket_android_hooks STATIC src/hooks.c)
  add_library(pocket::android_hooks ALIAS pocket_android_hooks)
  target_compile_features(pocket_android_hooks PUBLIC c_std_11)
  target_include_directories(pocket_android_hooks PUBLIC "${CMAKE_CURRENT_LIST_DIR}/include")
  target_link_libraries(pocket_android_hooks PUBLIC "${POCKET_ANDROID_LOG_LIBRARY}")
  set_target_properties(pocket_android_hooks PROPERTIES POSITION_INDEPENDENT_CODE ON)
endif()

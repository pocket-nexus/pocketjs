# Relocatable candidate SDK. The program supplies the six pocket_host_* hooks.
get_filename_component(_Pocket_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../.." ABSOLUTE)
include("${CMAKE_CURRENT_LIST_DIR}/PocketArchive.cmake")
if(NOT TARGET Pocket::runtime)
  add_library(Pocket::runtime STATIC IMPORTED GLOBAL)
  set_target_properties(Pocket::runtime PROPERTIES
    IMPORTED_LOCATION "${_Pocket_ROOT}/${Pocket_ARCHIVE}"
    INTERFACE_INCLUDE_DIRECTORIES "${_Pocket_ROOT}/include;${_Pocket_ROOT}/include/pocket"
    INTERFACE_LINK_LIBRARIES "${Pocket_NATIVE_STATIC_LIBS}")
endif()

# Source consumption leaves the C compiler, QuickJS target and engine options
# with the program. Define Pocket_QUICKJS_TARGET before find_package to attach
# the consumer's QuickJS include directories and link dependencies.
if(NOT TARGET Pocket::guest_quickjs)
  add_library(Pocket::guest_quickjs INTERFACE IMPORTED GLOBAL)
  set_target_properties(Pocket::guest_quickjs PROPERTIES
    INTERFACE_SOURCES "${_Pocket_ROOT}/src/guest-quickjs/guest.c"
    INTERFACE_INCLUDE_DIRECTORIES "${_Pocket_ROOT}/include/pocket"
    INTERFACE_COMPILE_FEATURES c_std_11
    INTERFACE_LINK_LIBRARIES Pocket::runtime)
endif()
if(DEFINED Pocket_QUICKJS_TARGET)
  if(NOT TARGET "${Pocket_QUICKJS_TARGET}")
    message(FATAL_ERROR "Pocket_QUICKJS_TARGET must name an existing consumer QuickJS target")
  endif()
  get_target_property(_Pocket_GUEST_LINKS Pocket::guest_quickjs INTERFACE_LINK_LIBRARIES)
  if(NOT "${Pocket_QUICKJS_TARGET}" IN_LIST _Pocket_GUEST_LINKS)
    set_property(TARGET Pocket::guest_quickjs APPEND PROPERTY INTERFACE_LINK_LIBRARIES "${Pocket_QUICKJS_TARGET}")
  endif()
endif()
set(Pocket_runtime_FOUND TRUE)
set(Pocket_guest_quickjs_FOUND TRUE)
foreach(_Pocket_COMPONENT IN LISTS Pocket_FIND_COMPONENTS)
  if(NOT _Pocket_COMPONENT STREQUAL "runtime" AND NOT _Pocket_COMPONENT STREQUAL "guest_quickjs")
    set(Pocket_FOUND FALSE)
    set(Pocket_NOT_FOUND_MESSAGE "Unknown Pocket component: ${_Pocket_COMPONENT}")
  endif()
endforeach()
unset(_Pocket_ROOT)
unset(_Pocket_COMPONENT)
unset(_Pocket_GUEST_LINKS)

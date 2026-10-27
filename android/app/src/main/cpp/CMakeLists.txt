# The app's own Node.js: libnode.so from nodejs-mobile (scripts/android-node.js puts it and its
# headers in android/app/libnode/, not in the repository) and nodehost, which starts it.
cmake_minimum_required(VERSION 3.22.1)
project(trackereditor)

set(LIBNODE ${CMAKE_SOURCE_DIR}/../../../libnode)

add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION ${LIBNODE}/bin/${ANDROID_ABI}/libnode.so)

add_library(nodehost SHARED nodehost.cpp)
target_include_directories(nodehost PRIVATE ${LIBNODE}/include/node)
find_library(log-lib log)
target_link_libraries(nodehost node ${log-lib})

# A pseudo-terminal for a shell on the phone, loaded by Node (mobile/node/pty.cjs).
add_library(trackerpty SHARED pty.c)
target_include_directories(trackerpty PRIVATE ${LIBNODE}/include/node)
target_link_libraries(trackerpty node)

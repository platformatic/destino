cmake_minimum_required(VERSION 3.20)
project(destino C)

# Setup folders
set(ROOT "${CMAKE_CURRENT_LIST_DIR}")
set(DOOMGENERIC "${ROOT}/deps/doomgeneric/doomgeneric")
set(DIST "${ROOT}/dist")
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${DIST}")

# Setup SDL 2 and SDL_mixer 2
find_package(PkgConfig REQUIRED)
pkg_check_modules(SDL REQUIRED sdl2 SDL2_mixer)

# Setup doomgeneric sources
# Taken from deps/doomgeneric/doomgeneric/Makefile, removing only doomgeneric_xlib.c and adding  i_sdlsound.c, i_sdlmusic.c and mus2mid.c
set(DOOM_SOURCES
  dummy.c
  am_map.c
  doomdef.c
  doomstat.c
  dstrings.c
  d_event.c
  d_items.c
  d_iwad.c
  d_loop.c
  d_main.c
  d_mode.c
  d_net.c
  f_finale.c
  f_wipe.c
  g_game.c
  hu_lib.c
  hu_stuff.c
  info.c
  i_cdmus.c
  i_endoom.c
  i_joystick.c
  i_scale.c
  i_sound.c
  i_system.c
  i_timer.c
  memio.c
  m_argv.c
  m_bbox.c
  m_cheat.c
  m_config.c
  m_controls.c
  m_fixed.c
  m_menu.c
  m_misc.c
  m_random.c
  p_ceilng.c
  p_doors.c
  p_enemy.c
  p_floor.c
  p_inter.c
  p_lights.c
  p_map.c
  p_maputl.c
  p_mobj.c
  p_plats.c
  p_pspr.c
  p_saveg.c
  p_setup.c
  p_sight.c
  p_spec.c
  p_switch.c
  p_telept.c
  p_tick.c
  p_user.c
  r_bsp.c
  r_data.c
  r_draw.c
  r_main.c
  r_plane.c
  r_segs.c
  r_sky.c
  r_things.c
  sha1.c
  sounds.c
  statdump.c
  st_lib.c
  st_stuff.c
  s_sound.c
  tables.c
  v_video.c
  wi_stuff.c
  w_checksum.c
  w_file.c
  w_main.c
  w_wad.c
  z_zone.c
  w_file_stdc.c
  i_input.c
  i_video.c
  doomgeneric.c
  i_sdlsound.c
  i_sdlmusic.c
  mus2mid.c
)
list(TRANSFORM DOOM_SOURCES PREPEND "${DOOMGENERIC}/")

# Setup compilation
add_compile_options(-ggdb3 -Os -DFEATURE_SOUND)

# Setup destino sources and linking
add_library(destino SHARED "${ROOT}/src/native/main.c" ${DOOM_SOURCES})
target_include_directories(destino PRIVATE "${DOOMGENERIC}" ${SDL_INCLUDE_DIRS})
target_link_directories(destino PRIVATE ${SDL_LIBRARY_DIRS})
target_link_libraries(destino PRIVATE ${SDL_LIBRARIES})

# Source specific fixes
set_source_files_properties("${DOOMGENERIC}/i_sound.c" PROPERTIES COMPILE_DEFINITIONS "I_PlaySong=doomgeneric_I_PlaySong")
set_source_files_properties("${DOOMGENERIC}/i_system.c" PROPERTIES COMPILE_DEFINITIONS "I_Quit=doomgeneric_I_Quit")

# Platform dependent settings
if(APPLE)
  set_target_properties(destino PROPERTIES OUTPUT_NAME "destino" PREFIX "" SUFFIX ".dylib")
else()
  set_target_properties(destino PROPERTIES OUTPUT_NAME "destino" PREFIX "" SUFFIX ".so")
endif()

# Copy assets
file(GLOB_RECURSE WAD_FILES "${ROOT}/deps/**/*.wad")
file(GLOB_RECURSE SF2_FILES "${ROOT}/deps/*.sf2")

add_custom_target(copy_wads ALL COMMAND ${CMAKE_COMMAND} -E make_directory "${CMAKE_LIBRARY_OUTPUT_DIRECTORY}/wads")
add_custom_target(copy_sf2s ALL COMMAND ${CMAKE_COMMAND} -E make_directory "${CMAKE_LIBRARY_OUTPUT_DIRECTORY}/sf2s")
add_custom_command(TARGET copy_wads POST_BUILD COMMAND ${CMAKE_COMMAND} -E copy_if_different ${WAD_FILES} "${CMAKE_LIBRARY_OUTPUT_DIRECTORY}/wads")
add_custom_command(TARGET copy_sf2s POST_BUILD COMMAND ${CMAKE_COMMAND} -E copy_if_different ${SF2_FILES} "${CMAKE_LIBRARY_OUTPUT_DIRECTORY}/sf2s")
add_dependencies(destino copy_wads copy_sf2s)


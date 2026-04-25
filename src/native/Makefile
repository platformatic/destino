.PHONY: all clean

UNAME_S := $(shell uname -s)

CC := clang
CFLAGS += -ggdb3 -Os -DFEATURE_SOUND
ROOT := $(abspath $(abspath $(dir $(lastword $(MAKEFILE_LIST))))/../..)
DOOMGENERIC := deps/doomgeneric/doomgeneric
MINIAUDIO := deps/miniaudio
# Taken from deps/doomgeneric/doomgeneric/Makefile, removing only doomgeneric_xlib.o and adding  i_sdlsound.o, i_sdlmusic.o and mus2mid.o
MODULES := dummy.o am_map.o doomdef.o doomstat.o dstrings.o d_event.o d_items.o d_iwad.o d_loop.o d_main.o d_mode.o d_net.o f_finale.o f_wipe.o g_game.o hu_lib.o hu_stuff.o info.o i_cdmus.o i_endoom.o i_joystick.o i_scale.o i_sound.o i_system.o i_timer.o memio.o m_argv.o m_bbox.o m_cheat.o m_config.o m_controls.o m_fixed.o m_menu.o m_misc.o m_random.o p_ceilng.o p_doors.o p_enemy.o p_floor.o p_inter.o p_lights.o p_map.o p_maputl.o p_mobj.o p_plats.o p_pspr.o p_saveg.o p_setup.o p_sight.o p_spec.o p_switch.o p_telept.o p_tick.o p_user.o r_bsp.o r_data.o r_draw.o r_main.o r_plane.o r_segs.o r_sky.o r_things.o sha1.o sounds.o statdump.o st_lib.o st_stuff.o s_sound.o tables.o v_video.o wi_stuff.o w_checksum.o w_file.o w_main.o w_wad.o z_zone.o w_file_stdc.o i_input.o i_video.o doomgeneric.o i_sdlsound.o i_sdlmusic.o mus2mid.o
DIST := $(ROOT)/dist
BUILD := $(ROOT)/tmp
OBJS := $(addprefix $(BUILD)/, $(MODULES))


ifeq ($(UNAME_S),Darwin)
    OUTPUT := $(DIST)/doom.dylib
		CFLAGS := $(CFLAGS) $(shell pkg-config --cflags SDL2_mixer)
		LDFLAGS := $(shell pkg-config --libs SDL2_mixer)
else
    OUTPUT := $(DIST)/doom.so
endif

all: $(OUTPUT)
	clang -shared -o $(OUTPUT) $(LDFLAGS) $(BUILD)/*.o -lm

clean:
	rm -rf $(DIST) $(BUILD)

$(OUTPUT): $(DIST) $(BUILD) $(OBJS) $(BUILD)/main.o
	
$(BUILD)/main.o: $(ROOT)/src/native/main.c
	$(CC) $(CFLAGS)  -c $(ROOT)/src/native/main.c -I $(ROOT)/$(DOOMGENERIC) -I $(ROOT)/$(MINIAUDIO) -o $(BUILD)/main.o

$(BUILD)/%.o: $(ROOT)/$(DOOMGENERIC)/%.c 
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD)/i_sound.o: $(ROOT)/$(DOOMGENERIC)/i_sound.c
	$(CC) $(CFLAGS) -DI_PlaySong=doomgeneric_I_PlaySong -c $< -o $@

$(BUILD)/i_system.o: $(ROOT)/$(DOOMGENERIC)/i_system.c
	$(CC) $(CFLAGS) -DI_Quit=doomgeneric_I_Quit -c $< -o $@
	
$(DIST):
	mkdir -p $(DIST)

$(BUILD):
	mkdir -p $(BUILD)

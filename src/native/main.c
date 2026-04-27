
#include <SDL_mixer.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "doomgeneric.h"
#include "i_sound.h"
#include "i_system.h"

#define KEY_QUEUE_SIZE 1024

typedef void (*SetTitleWindowFn)(const char*);

typedef struct {
  unsigned char key;
  int pressed;
} KeyEvent;

typedef struct {
  KeyEvent queue[KEY_QUEUE_SIZE];
  uint16_t write_position;
  uint16_t read_position;
} KeyInputs;

typedef struct {
  int32_t argn;
  char** args;
  KeyInputs input;
  int frame_ready;
  int quit_requested;
  int music_blocked;
  void* pending_song_handle;
  boolean pending_song_looping;
  uint32_t frame_generation;
  SetTitleWindowFn set_window_title;
} Runtime;

Runtime* runtime;
extern int show_endoom;

void init(int32_t argn, char** args, char* sf2Path, SetTitleWindowFn set_window_title) {
  runtime = calloc(1, sizeof(Runtime));
  runtime->argn = argn;
  runtime->args = malloc(sizeof(char*) * argn);
  runtime->music_blocked = 1;
  runtime->set_window_title = set_window_title;
  show_endoom = 0;

  if (sf2Path != NULL) {
    Mix_SetSoundFonts(sf2Path);
  }

  // Args must be duplicated since the original buffer will be freed by Node.js after the call.
  // doomgeneric instead checks for these args during tick.
  for (int i = 0; i < argn; i++) {
    runtime->args[i] = strdup(args[i]);
  }

  doomgeneric_Create(runtime->argn, runtime->args);
}

void cleanup() {
  if (runtime == NULL) {
    return;
  }

  I_ShutdownSound();
  I_ShutdownMusic();

  for (int i = 0; i < runtime->argn; i++) {
    free(runtime->args[i]);
  }
  free(runtime->args);
  free(runtime);

  runtime = NULL;
}

void send_key(unsigned char key, int pressed) {
  if (runtime == NULL) {
    return;
  }

  uint16_t next_write_position = (runtime->input.write_position + 1) % KEY_QUEUE_SIZE;

  // Queue is full, drop the oldest event
  if (next_write_position == runtime->input.read_position) {
    runtime->input.read_position = (runtime->input.read_position + 1) % KEY_QUEUE_SIZE;
  }

  runtime->input.queue[runtime->input.write_position].key = key;
  runtime->input.queue[runtime->input.write_position].pressed = pressed;
  runtime->input.write_position = next_write_position;
}

pixel_t* get_framebuffer() {
  return DG_ScreenBuffer;
}

int32_t get_frame_width() {
  return DOOMGENERIC_RESX;
}

int32_t get_frame_height() {
  return DOOMGENERIC_RESY;
}

int frame_ready() {
  return runtime != NULL && runtime->frame_ready;
}

uint32_t get_frame_generation() {
  return runtime == NULL ? 0 : runtime->frame_generation;
}

void clear_frame_ready() {
  if (runtime != NULL) {
    runtime->frame_ready = 0;
  }
}

int quit_requested() {
  return runtime != NULL && runtime->quit_requested;
}

void doomgeneric_I_PlaySong(void* handle, boolean looping);

void I_PlaySong(void* handle, boolean looping) {
  if (runtime != NULL && runtime->music_blocked) {
    runtime->pending_song_handle = handle;
    runtime->pending_song_looping = looping;
    return;
  }

  doomgeneric_I_PlaySong(handle, looping);
}

void release_audio() {
  if (runtime == NULL || !runtime->music_blocked) {
    return;
  }

  runtime->music_blocked = 0;

  if (runtime->pending_song_handle != NULL) {
    doomgeneric_I_PlaySong(runtime->pending_song_handle, runtime->pending_song_looping);
    runtime->pending_song_handle = NULL;
  }
}

void I_Quit() {
  if (runtime != NULL) {
    runtime->quit_requested = 1;
  }
}

void DG_Init() {
  // Nothing to do here
}

void DG_SleepMs(uint32_t ms) {
  // Purposely no-op, Node.js will take care of managing time
}

void DG_SetWindowTitle(const char* title) {
  if (runtime == NULL) {
    return;
  }

  runtime->set_window_title(title);
}

uint32_t DG_GetTicksMs() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (ts.tv_sec * 1000) + (ts.tv_nsec / 1000000);
}

int DG_GetKey(int* pressed, unsigned char* key) {
  if (runtime == NULL) {
    return 0;
  }

  if (runtime->input.write_position == runtime->input.read_position) {
    return 0;
  }

  KeyEvent ev = runtime->input.queue[runtime->input.read_position];
  runtime->input.read_position = (runtime->input.read_position + 1) % KEY_QUEUE_SIZE;

  *pressed = ev.pressed;
  *key = ev.key;

  return 1;
}

void DG_DrawFrame() {
  if (runtime == NULL) {
    return;
  }

  uint32_t* pixels = (uint32_t*) DG_ScreenBuffer;
  int pixels_count = DOOMGENERIC_RESX * DOOMGENERIC_RESY;

  for (int i = 0; i < pixels_count; i++) {
    pixels[i] |= 0xff000000;
  }

  runtime->frame_ready = 1;
  runtime->frame_generation++;
}

// SPDX-License-Identifier: GPL-3.0-or-later

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "doomgeneric.h"
#include "i_sound.h"
#include "i_system.h"
#include "files.h"

/*
 * This file adapts DoomGeneric's platform callbacks to a JavaScript host.
 * It does not own an event loop: Node calls doomgeneric_Tick(), supplies input,
 * and reads the framebuffer. The DG_* functions below are the services that
 * DoomGeneric would otherwise obtain from a windowing or operating-system port.
 *
 * All entry points run on Node's main thread. The JavaScript side must keep the
 * dynamic library loaded and its callback registered until cleanup completes.
 * Audio production and MIDI state live separately in audio.c.
 */
#define KEY_QUEUE_SIZE 1024

// The callback receives a borrowed, NUL-terminated C string. JavaScript copies
// it during the call; retaining this pointer after returning would be unsafe.
typedef void (*SetTitleWindowFn)(const char*);

typedef struct {
  unsigned char key;
  int pressed;
} KeyEvent;

typedef struct {
  KeyEvent queue[KEY_QUEUE_SIZE];
  // Equal positions mean empty. We leave one slot unused to distinguish a full
  // queue from an empty one without maintaining a separate event count.
  uint16_t write_position;
  uint16_t read_position;
} KeyInputs;

typedef struct {
  // Doom keeps consulting argv after startup, so Runtime owns these copies.
  int32_t argn;
  char** args;
  KeyInputs input;
  int frame_ready;
  int quit_requested;
  // A generation number identifies completed frames, independently of how
  // often the host polls or clears the readiness flag.
  uint32_t frame_generation;
  SetTitleWindowFn set_window_title;
} Runtime;

Runtime* runtime;
extern int show_endoom;

// The build redirects upstream console chatter here. Keep stderr diagnostics
// available and leave the process stdout descriptor untouched: Node uses it
// for Kitty graphics. These functions also suppress messages during later ticks.
int destino_printf(const char *format, ...) {
  return 0;
}

int destino_puts(const char *message) {
  return 0;
}

int destino_putchar(int character) {
  return (unsigned char) character;
}

// Public FFI entry point. Fixed-width argument types make the JS declaration
// independent of platform-specific C integer sizes. Initialization is intended
// to happen once per loaded engine; upstream Doom also owns global state.
void init(int32_t argn, char** args, SetTitleWindowFn set_window_title) {
  runtime = calloc(1, sizeof(Runtime));
  runtime->argn = argn;
  runtime->args = malloc(sizeof(char*) * argn);
  runtime->set_window_title = set_window_title;
  // ENDOOM is a native exit screen. The JavaScript terminal renderer handles
  // terminal restoration, so displaying that screen would interfere with it.
  show_endoom = 0;

  // FFI only borrows the JavaScript buffers during this call. strdup transfers
  // the contents into native-owned storage before those buffers can be freed.
  for (int i = 0; i < argn; i++) {
    runtime->args[i] = strdup(args[i]);
  }

  // This initializes the WAD, game state, and framebuffer; subsequent work is
  // advanced explicitly by the host through doomgeneric_Tick().
  doomgeneric_Create(runtime->argn, runtime->args);
}

void cleanup() {
  // A soundfont may have been loaded before Doom initialization failed. Release
  // audio even when no Runtime exists. Both audio shutdown functions tolerate
  // repeated calls, making partially initialized startup safe to clean up.
  I_ShutdownSound();
  I_ShutdownMusic();
  files_shutdown();

  if (runtime == NULL) {
    return;
  }

  for (int i = 0; i < runtime->argn; i++) {
    free(runtime->args[i]);
  }
  free(runtime->args);
  free(runtime);

  runtime = NULL;
}

// JavaScript submits key transitions, not terminal escape sequences. Keeping
// both press and release events allows held movement and simultaneous actions.
void send_key(unsigned char key, int pressed) {
  if (runtime == NULL) {
    return;
  }

  uint16_t next_write_position = (runtime->input.write_position + 1) % KEY_QUEUE_SIZE;

  // Queue is full: discard the oldest event so recent input remains responsive.
  // This is a bounded queue, so a stalled game cannot allocate unlimited memory.
  if (next_write_position == runtime->input.read_position) {
    runtime->input.read_position = (runtime->input.read_position + 1) % KEY_QUEUE_SIZE;
  }

  runtime->input.queue[runtime->input.write_position].key = key;
  runtime->input.queue[runtime->input.write_position].pressed = pressed;
  runtime->input.write_position = next_write_position;
}

pixel_t* get_framebuffer() {
  // The engine owns this allocation. JavaScript may create a zero-copy view,
  // but must neither free it nor access it after unloading the native library.
  return DG_ScreenBuffer;
}

// Expose the dimensions of the actual allocated buffer rather than assuming
// that the classic Doom resolution matches this port's scaled output.
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
  // The host acknowledges presentation separately from producing a frame.
  // Merely reading the pixels does not change this flag.
  if (runtime != NULL) {
    runtime->frame_ready = 0;
  }
}

int quit_requested() {
  return runtime != NULL && runtime->quit_requested;
}

void I_Quit() {
  // Convert Doom's exit request into a flag instead of terminating Node.
  // The build renames upstream I_Quit so this host-controlled version is used.
  if (runtime != NULL) {
    runtime->quit_requested = 1;
  }
}

void DG_Init() {
  // No native window or device is needed: JavaScript owns presentation.
}

void DG_SleepMs(uint32_t ms) {
  // Sleeping here would block the JavaScript event loop. Node schedules the
  // next tick; Doom can still query real elapsed time through DG_GetTicksMs.
}

void DG_SetWindowTitle(const char* title) {
  if (runtime == NULL) {
    return;
  }

  // SAFETY: The host retains this FFI callback for Runtime's lifetime, and
  // Doom invokes it synchronously on the same thread that registered it.
  runtime->set_window_title(title);
}

uint32_t DG_GetTicksMs() {
  // A monotonic clock is immune to wall-clock corrections. The unsigned
  // millisecond counter naturally wraps, as expected by Doom's timing code.
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

  // Consume one event per call. Doom polls until this callback reports that
  // the queue is empty; output pointers belong to that synchronous caller.
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

  // On the supported little-endian targets, 0xAARRGGBB is stored as BGRA bytes.
  // Doom does not supply meaningful alpha, so mark every pixel opaque before
  // exposing the frame to the terminal renderer. RGB content is preserved.
  uint32_t* pixels = (uint32_t*) DG_ScreenBuffer;
  int pixels_count = DOOMGENERIC_RESX * DOOMGENERIC_RESY;

  for (int i = 0; i < pixels_count; i++) {
    pixels[i] |= 0xff000000;
  }

  // Publishing happens after all pixel writes. No locking is needed because
  // the host and Doom access this buffer sequentially on the same thread.
  runtime->frame_ready = 1;
  runtime->frame_generation++;
}

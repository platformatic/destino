// SPDX-License-Identifier: GPL-3.0-or-later

#include <stdint.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "i_sound.h"
#include "m_argv.h"
#include "m_config.h"
#include "w_wad.h"
#include "memio.h"
#include "mus2mid.h"

/*
 * Native audio pipeline:
 *
 *   WAD sound lumps -> unsigned 8-bit mono samples -> effect channels --+
 *                                                                    +-> PCM
 *   WAD MUS/MIDI -> MIDI events -> TinySoundFont + SF2 -> music --------+
 *
 * Node pulls PCM from audio_render() and gives it to SDL3 through FFI.
 * Nothing in this file talks to an audio device or runs on SDL's audio thread.
 * This keeps game updates, sample ownership, and MIDI scheduling single-threaded.
 * The I_* functions implement the interface expected by Doom's sound manager;
 * its original SDL sound/music implementation is excluded from the build.
 */

// These single-header libraries emit their implementation in exactly this
// translation unit. Static linkage keeps their symbols private to our backend.
#define TSF_IMPLEMENTATION
#define TSF_STATIC
#include "tsf.h"
#define TML_IMPLEMENTATION
#define TML_STATIC
#define TML_NO_STDIO
#include "tml.h"

#define AUDIO_RATE 44100
#define AUDIO_CHANNELS 16
// 44100 / 35 = 1260: one host tick produces an exact integer number of frames.
// A stereo frame contains two samples, so its signed-16 representation is 4 bytes.
#define AUDIO_FRAMES 1260

// All mixing happens on Node's thread. SDL receives a synchronous copy of PCM.
typedef struct {
  // Each channel owns its sample allocation. Starting a replacement effect or
  // reaching its end releases that allocation; WAD memory is never retained.
  unsigned char *samples;
  uint32_t length;
  uint64_t position;
  // position is measured in source-rate / output-rate units: each output frame
  // advances it by rate, and division by AUDIO_RATE gives the source index.
  uint32_t rate;
  int left;
  int right;
} Channel;

static Channel channels[AUDIO_CHANNELS];
static int16_t pcm[AUDIO_FRAMES * 2];
static boolean initialized;
static boolean prefix;

typedef struct Song {
  // TML allocates a linked event list with one owning head pointer. Song owns
  // that head; next_event below only borrows nodes during playback.
  tml_message *messages;
  uint64_t duration;
  struct Song *next;
} Song;

static tsf *synth;
// Registered songs can outlive playback. Keeping a registry lets unregister
// stop the active song safely and lets shutdown release forgotten handles.
static Song *songs;
static Song *song;
static tml_message *next_event;
static uint64_t music_position;
static boolean music_initialized;
static boolean music_paused;
static boolean music_looping;
static boolean music_ending;
// Music volume is applied after synthesis. Muting therefore does not stop
// event processing, sample positions, or instrument envelope progression.
static int music_volume = 127;
static float music_pcm[AUDIO_FRAMES * 2];

int snd_samplerate = AUDIO_RATE;
int snd_cachesize = 0;
int snd_maxslicetime_ms = 28;
int snd_sfxdevice = SNDDEVICE_SB;
int snd_musicdevice = SNDDEVICE_GENMIDI;
char *snd_musiccmd = "";

void I_StopSound(int channel) {
  if (channel < 0 || channel >= AUDIO_CHANNELS) {
    return;
  }
  free(channels[channel].samples);
  memset(&channels[channel], 0, sizeof(Channel));
}

void I_ShutdownSound(void) {
  for (int channel = 0; channel < AUDIO_CHANNELS; channel++) {
    I_StopSound(channel);
  }
  initialized = false;
}

void I_InitSound(boolean use_sfx_prefix) {
  // Reset effect state only. Music initialization is a separate Doom hook and
  // must not lose the soundfont already loaded by JavaScript before startup.
  I_ShutdownSound();
  prefix = use_sfx_prefix;
  initialized = snd_sfxdevice != SNDDEVICE_NONE && !M_CheckParm("-nosound") && !M_CheckParm("-nosfx");
}

int I_GetSfxLumpNum(sfxinfo_t *sfx) {
  char name[12];
  if (sfx->link != NULL) {
    // Several logical effects may refer to the same underlying WAD sample.
    sfx = sfx->link;
  }
  snprintf(name, sizeof(name), "%s%.8s", prefix ? "ds" : "", sfx->name);
  return W_GetNumForName(name);
}

void I_UpdateSoundParams(int channel, int volume, int separation) {
  if (channel < 0 || channel >= AUDIO_CHANNELS) {
    return;
  }
  volume = volume < 0 ? 0 : volume > 127 ? 127 : volume;
  separation = separation < 0 ? 0 : separation > 254 ? 254 : separation;
  // Doom's ranges are 0..127 for volume and 0..254 for separation. Linear
  // panning puts half the amplitude in each ear at the center (127).
  // Store integer numerators here and normalize while mixing samples.
  channels[channel].left = volume * (254 - separation);
  channels[channel].right = volume * separation;
}

int I_StartSound(sfxinfo_t *sfx, int channel, int volume, int separation) {
  if (!initialized || channel < 0 || channel >= AUDIO_CHANNELS) {
    return -1;
  }
  I_StopSound(channel);
  // A DMX lump begins with an 8-byte little-endian header: format (2 bytes),
  // sample rate (2 bytes), then sample count (4 bytes). Decode bytes explicitly
  // instead of casting, which would assume native endianness and alignment.
  int size = W_LumpLength(sfx->lumpnum);
  if (size < 8) {
    return -1;
  }
  unsigned char *data = malloc((size_t) size);
  if (data == NULL) {
    return -1;
  }
  W_ReadLump(sfx->lumpnum, data);
  uint32_t rate = (uint32_t) data[2] | ((uint32_t) data[3] << 8);
  uint32_t length = (uint32_t) data[4] | ((uint32_t) data[5] << 8)
                  | ((uint32_t) data[6] << 16) | ((uint32_t) data[7] << 24);
  // Validate the declared sample count against the actual WAD allocation before
  // reading samples. Tiny/unsupported lumps are ignored, matching the old port.
  if (data[0] != 3 || data[1] != 0 || rate == 0 || length <= 48 || length > (uint32_t) size - 8) {
    free(data);
    return -1;
  }
  // DMX skips 16 padding samples at both ends of an unsigned 8-bit mono lump.
  length -= 32;
  memmove(data, data + 24, length);
  channels[channel].samples = data;
  channels[channel].length = length;
  channels[channel].rate = rate;
  I_UpdateSoundParams(channel, volume, separation);
  return channel;
}

boolean I_SoundIsPlaying(int channel) {
  return channel >= 0 && channel < AUDIO_CHANNELS && channels[channel].samples != NULL;
}

static void ResetMusicSynth(void) {
  if (synth == NULL) {
    return;
  }
  tsf_reset(synth);
  // TinySoundFont's reset uses a 10ms release. Drain it off-output so notes
  // from the old song cannot bleed into a new song or the next loop.
  float discard[(AUDIO_RATE / 100 + 1) * 2];
  tsf_render_float(synth, discard, AUDIO_RATE / 100 + 1, 0);
  for (int channel = 0; channel < 16; channel++) {
    tsf_channel_set_presetnumber(synth, channel, 0, channel == 9);
  }
}

void I_StopSong(void) {
  song = NULL;
  next_event = NULL;
  music_position = 0;
  music_paused = false;
  music_ending = false;
  ResetMusicSynth();
}

void I_ShutdownMusic(void) {
  song = NULL;
  next_event = NULL;
  music_initialized = false;
  while (songs != NULL) {
    Song *next = songs->next;
    tml_free(songs->messages);
    free(songs);
    songs = next;
  }
  if (synth != NULL) {
    tsf_close(synth);
    synth = NULL;
  }
}

int audio_load_soundfont(const void *data, int size) {
  // FFI startup hook: TSF parses the borrowed bytes into native-owned storage.
  // No JavaScript memory is retained, and loading never needs a native file path.
  // Return a status to JavaScript, which reports a coded AudioError on failure.
  I_ShutdownMusic();
  synth = data == NULL || size <= 0 ? NULL : tsf_load_memory(data, size);
  if (synth == NULL) {
    return 0;
  }
  tsf_set_output(synth, TSF_STEREO_INTERLEAVED, AUDIO_RATE, 0);
  // A single SF2 note can use multiple layers/voices. Bound polyphony and
  // preallocate voices to avoid repeated voice-array growth while rendering.
  if (!tsf_set_max_voices(synth, 256)) {
    I_ShutdownMusic();
    return 0;
  }
  ResetMusicSynth();
  return 1;
}

void I_InitMusic(void) {
  music_initialized = synth != NULL && snd_musicdevice != SNDDEVICE_NONE
                   && !M_CheckParm("-nosound") && !M_CheckParm("-nomusic");
}

void I_SetMusicVolume(int volume) {
  music_volume = volume < 0 ? 0 : volume > 127 ? 127 : volume;
}

void I_PauseSong(void) { music_paused = true; }
void I_ResumeSong(void) { music_paused = false; }

void *I_RegisterSong(void *data, int length) {
  // Registration decodes the score but does not start it. The resulting event
  // list owns its data, allowing Doom to release the original WAD lump later.
  if (!music_initialized) {
    return NULL;
  }
  tml_message *messages = NULL;
  if (data != NULL && length >= 4 && memcmp(data, "MThd", 4) == 0) {
    messages = tml_load_memory(data, length);
  } else if (data != NULL && length >= 16 && memcmp(data, "MUS\x1a", 4) == 0) {
    // Reuse DoomGeneric's MUS converter with memory streams. No intermediate
    // MIDI file is written to disk, and TML consumes the result before it closes.
    MEMFILE *input = mem_fopen_read(data, (size_t) length);
    MEMFILE *output = mem_fopen_write();
    if (input != NULL && output != NULL && mus2mid(input, output) == 0) {
      void *midi;
      size_t size;
      mem_get_buf(output, &midi, &size);
      if (size <= INT_MAX) {
        messages = tml_load_memory(midi, (int) size);
      }
    }
    if (input != NULL) {
      mem_fclose(input);
    }
    if (output != NULL) {
      mem_fclose(output);
    }
  }
  if (messages == NULL) {
    fprintf(stderr, "DESTINO_MIDI_INVALID: Cannot decode MUS/MIDI song.\n");
    return NULL;
  }
  Song *registered = calloc(1, sizeof(Song));
  if (registered == NULL) {
    tml_free(messages);
    fprintf(stderr, "DESTINO_MIDI_MEMORY: Cannot allocate song.\n");
    return NULL;
  }
  registered->messages = messages;
  // TML merges tracks and resolves tempo changes into millisecond timestamps.
  // Convert to output frames with ceiling division: never dispatch an event
  // earlier than its timestamp. Precision is limited to TML's millisecond clock.
  for (tml_message *event = messages; event != NULL; event = event->next) {
    registered->duration = ((uint64_t) event->time * AUDIO_RATE + 999) / 1000;
  }
  // A zero-duration MIDI must not spin forever when looping.
  if (registered->duration == 0) {
    registered->duration = 1;
  }
  registered->next = songs;
  songs = registered;
  return registered;
}

void I_UnRegisterSong(void *handle) {
  // Search by identity before dereferencing a caller-supplied handle. Removing
  // the active score first stops playback, so next_event cannot become dangling.
  Song **link = &songs;
  while (*link != NULL && *link != handle) {
    link = &(*link)->next;
  }
  if (*link == NULL) {
    return;
  }
  if (song == handle) {
    I_StopSong();
  }
  Song *removed = *link;
  *link = removed->next;
  tml_free(removed->messages);
  free(removed);
}

void I_PlaySong(void *handle, boolean looping) {
  // Starting a song also resets controller state and discards the previous
  // song's release tails. MIDI channels must not inherit a previous level's bank,
  // sustain pedal, pitch wheel, or instrument selection.
  I_StopSong();
  if (!music_initialized || handle == NULL) {
    return;
  }
  for (Song *registered = songs; registered != NULL; registered = registered->next) {
    if (registered == handle) {
      song = registered;
      next_event = song->messages;
      music_looping = looping;
      return;
    }
  }
}

boolean I_MusicIsPlaying(void) { return song != NULL; }
void I_InitTimidityConfig(void) {}

static void DispatchMusicEvent(const tml_message *event) {
  // MIDI uses zero-based channel numbers; channel 9 is the GM percussion channel.
  // TSF handles velocity-zero note-ons as note-offs and implements standard
  // volume, expression, pan, sustain, bank, and pitch-range controllers.
  int channel = event->channel;
  switch (event->type) {
    case TML_NOTE_ON:
      tsf_channel_note_on(synth, channel, event->key, event->velocity / 127.0f);
      break;
    case TML_NOTE_OFF:
      tsf_channel_note_off(synth, channel, event->key);
      break;
    case TML_PROGRAM_CHANGE:
      tsf_channel_set_presetnumber(synth, channel, event->program, channel == 9);
      break;
    case TML_CONTROL_CHANGE:
      tsf_channel_midi_control(synth, channel, event->control, event->control_value);
      break;
    case TML_PITCH_BEND:
      tsf_channel_set_pitchwheel(synth, channel, event->pitch_bend);
      break;
    default:
      // TML has already applied tempo changes to event timestamps.
      break;
  }
}

static void RenderMusic(int frames) {
  memset(music_pcm, 0, (size_t) frames * 2 * sizeof(float));
  // Pause freezes both the score clock and synthesizer envelopes, but effects
  // continue through audio_render(). Silence is produced without losing notes.
  if (!music_initialized || music_paused || song == NULL) {
    return;
  }
  int offset = 0;
  while (offset < frames && song != NULL) {
    // Dispatch all simultaneous events before generating the next frame. Using
    // integer comparisons prevents floating-point clock drift across long songs.
    while (next_event != NULL && (uint64_t) next_event->time * AUDIO_RATE <= music_position * 1000) {
      DispatchMusicEvent(next_event);
      next_event = next_event->next;
    }
    if (next_event == NULL && music_position >= song->duration && !music_ending) {
      if (music_looping) {
        ResetMusicSynth();
        music_position = 0;
        next_event = song->messages;
        continue;
      }
      // Release held notes, including sustain, and render the natural tail.
      for (int channel = 0; channel < 16; channel++) {
        tsf_channel_set_sustain(synth, channel, 0);
        tsf_channel_note_off_all(synth, channel);
      }
      music_ending = true;
    }
    if (music_ending && tsf_active_voice_count(synth) == 0) {
      song = NULL;
      break;
    }
    int count = frames - offset;
    // Split the output block at the next MIDI boundary rather than delaying
    // events until the next JavaScript tick. A loop can restart inside a block.
    uint64_t boundary = next_event != NULL
      ? ((uint64_t) next_event->time * AUDIO_RATE + 999) / 1000 : song->duration;
    if (!music_ending && boundary > music_position && boundary - music_position < (uint64_t) count) {
      count = (int) (boundary - music_position);
    }
    tsf_render_float(synth, music_pcm + offset * 2, count, 0);
    offset += count;
    music_position += count;
  }
}

// Return signed-16 stereo at 44100 Hz. The caller consumes the buffer before
// the next call; rational sample positions avoid resampling drift.
int16_t *audio_render(int frames) {
  if (frames < 0 || frames > AUDIO_FRAMES) {
    return NULL;
  }
  memset(pcm, 0, (size_t) frames * 2 * sizeof(int16_t));
  RenderMusic(frames);
  for (int frame = 0; frame < frames; frame++) {
    // Mix in float so music and effects are saturated together only once.
    float left = music_pcm[frame * 2] * 32768.0f * music_volume / 127.0f;
    float right = music_pcm[frame * 2 + 1] * 32768.0f * music_volume / 127.0f;
    for (int index = 0; index < AUDIO_CHANNELS; index++) {
      Channel *channel = &channels[index];
      if (channel->samples == NULL) {
        continue;
      }
      uint32_t sample = (uint32_t) (channel->position / AUDIO_RATE);
      // Linear interpolation between adjacent source samples supports arbitrary
      // WAD rates. Clamp the second index at the end to avoid a one-byte overread.
      uint32_t next = sample + 1 < channel->length ? sample + 1 : sample;
      int32_t value = ((int32_t) channel->samples[sample] - 128) * 256;
      // Unsigned 8-bit PCM has silence at 128. Center it on zero and scale to
      // signed-16 amplitude before interpolation and per-channel panning.
      int32_t delta = ((int32_t) channel->samples[next] - channel->samples[sample]) * 256;
      value += (int32_t) ((int64_t) delta * (int64_t) (channel->position % AUDIO_RATE) / AUDIO_RATE);
      left += value * channel->left / (127 * 254);
      right += value * channel->right / (127 * 254);
      channel->position += channel->rate;
      if (channel->position / AUDIO_RATE >= channel->length) {
        I_StopSound(index);
      }
    }
    // Saturation prevents loud overlapping sources from wrapping from positive
    // to negative values. Interleave L,R pairs in the buffer SDL3 will consume.
    pcm[frame * 2] = (int16_t) (left < -32768 ? -32768 : left > 32767 ? 32767 : left);
    pcm[frame * 2 + 1] = (int16_t) (right < -32768 ? -32768 : right > 32767 ? 32767 : right);
  }
  return pcm;
}

void I_UpdateSound(void) {}
void I_PrecacheSounds(sfxinfo_t *sounds, int count) {}

void I_BindSoundVariables(void) {
  // Retain Doom's configuration bindings so its menus and saved settings still
  // control this backend. The PCM output format itself remains fixed at 44100 Hz.
  M_BindVariable("snd_sfxdevice", &snd_sfxdevice);
  M_BindVariable("snd_musicdevice", &snd_musicdevice);
  M_BindVariable("snd_samplerate", &snd_samplerate);
  M_BindVariable("snd_cachesize", &snd_cachesize);
  M_BindVariable("snd_maxslicetime_ms", &snd_maxslicetime_ms);
  M_BindVariable("snd_musiccmd", &snd_musiccmd);
}

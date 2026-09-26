// SPDX-License-Identifier: GPL-3.0-or-later

#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include "doomstat.h"

// Upstream stdio calls are redirected here at compile time. In development
// they use libc unchanged. SEA mounts its IWAD before initialization, switching
// engine files to process memory, except the explicitly mapped save files.
// These are real libc FILE streams, so fscanf/fprintf and buffering still work.
typedef struct MemoryFile {
  char *name;
  unsigned char *data;
  size_t size;
  struct MemoryFile *next;
} MemoryFile;

typedef struct MemoryStream {
  MemoryFile *file;
  size_t position;
  int writable;
  int append;
  FILE *handle;
  struct MemoryStream *next;
} MemoryStream;

static MemoryFile *files;
static int mounted;
static MemoryStream *streams;
static char save_directory[PATH_MAX];

static int SavePath(const char *name, char *path) {
  if (save_directory[0] == '\0') {
    return 0;
  }
  const char *base = strrchr(name, '/');
  base = base == NULL ? name : base + 1;
  // Recovery saves use Doom's temporary directory. Map them into the same
  // persistent save directory, never the host's temporary directory.
  int recovery = strcmp(base, "recovery.dsg") == 0;
  if (!recovery) {
    if (savegamedir == NULL || strncmp(name, savegamedir, strlen(savegamedir)) != 0 ||
        name + strlen(savegamedir) != base) {
      return 0;
    }
    if (strcmp(base, "temp.dsg") != 0) {
      if (strncmp(base, "doomsav", 7) != 0) {
        return 0;
      }
      const char *slot = base + 7;
      const char *end = slot;
      while (*end >= '0' && *end <= '9') {
        end++;
      }
      if (end == slot || strcmp(end, ".dsg") != 0) {
        return 0;
      }
    }
  }
  int length = snprintf(path, PATH_MAX, "%s/%s", save_directory, base);
  if (length < 0 || length >= PATH_MAX) {
    errno = ENAMETOOLONG;
    return -1;
  }
  return 1;
}

static MemoryFile *FindFile(const char *name) {
  for (MemoryFile *file = files; file != NULL; file = file->next) {
    if (file->name != NULL && strcmp(file->name, name) == 0) {
      return file;
    }
  }
  return NULL;
}

static MemoryFile *CreateFile(const char *name) {
  MemoryFile *file = calloc(1, sizeof(*file));
  if (file == NULL) {
    return NULL;
  }
  file->name = strdup(name);
  if (file->name == NULL) {
    free(file);
    return NULL;
  }
  file->next = files;
  files = file;
  return file;
}

static ssize_t ReadMemory(void *cookie, char *buffer, size_t size) {
  MemoryStream *stream = cookie;
  size_t available = stream->position < stream->file->size ? stream->file->size - stream->position : 0;
  if (size > available) {
    size = available;
  }
  if (size > 0) {
    memcpy(buffer, stream->file->data + stream->position, size);
    stream->position += size;
  }
  return (ssize_t) size;
}

static ssize_t WriteMemory(void *cookie, const char *buffer, size_t size) {
  MemoryStream *stream = cookie;
  MemoryFile *file = stream->file;
  if (!stream->writable) {
    errno = EBADF;
    return -1;
  }
  if (stream->append) {
    stream->position = file->size;
  }
  if (size > SIZE_MAX - stream->position) {
    errno = EFBIG;
    return -1;
  }
  size_t end = stream->position + size;
  if (end > file->size) {
    unsigned char *data = realloc(file->data, end);
    if (data == NULL) {
      errno = ENOMEM;
      return -1;
    }
    memset(data + file->size, 0, end - file->size);
    file->data = data;
    file->size = end;
  }
  if (size > 0) {
    memcpy(file->data + stream->position, buffer, size);
  }
  stream->position = end;
  return (ssize_t) size;
}

static int64_t SeekMemory(MemoryStream *stream, int64_t offset, int whence) {
  int64_t base;
  switch (whence) {
    case SEEK_SET: base = 0; break;
    case SEEK_CUR: base = (int64_t) stream->position; break;
    case SEEK_END: base = (int64_t) stream->file->size; break;
    default: errno = EINVAL; return -1;
  }
  if (offset < -base || (offset > 0 && base > INT64_MAX - offset)) {
    errno = EINVAL;
    return -1;
  }
  stream->position = (size_t) (base + offset);
  return (int64_t) stream->position;
}

static int CloseMemory(void *cookie) {
  MemoryStream **link = &streams;
  while (*link != NULL && *link != cookie) {
    link = &(*link)->next;
  }
  if (*link != NULL) {
    *link = (*link)->next;
  }
  free(cookie);
  return 0;
}

#ifdef __APPLE__
// funopen and fopencookie have different callback ABIs, but share the storage.
static int ReadCookie(void *cookie, char *buffer, int size) {
  return (int) ReadMemory(cookie, buffer, (size_t) size);
}
static int WriteCookie(void *cookie, const char *buffer, int size) {
  return (int) WriteMemory(cookie, buffer, (size_t) size);
}
static fpos_t SeekCookie(void *cookie, fpos_t offset, int whence) {
  return (fpos_t) SeekMemory(cookie, offset, whence);
}
#else
static int SeekCookie(void *cookie, off64_t *offset, int whence) {
  int64_t position = SeekMemory(cookie, *offset, whence);
  if (position < 0) {
    return -1;
  }
  *offset = position;
  return 0;
}
#endif

FILE *destino_fopen(const char *name, const char *mode) {
  if (!mounted) {
    return fopen(name, mode);
  }
  char path[PATH_MAX];
  int save = SavePath(name, path);
  if (save != 0) {
    return save < 0 ? NULL : fopen(path, mode);
  }
  MemoryFile *file = FindFile(name);
  if (file == NULL && mode[0] != 'r') {
    file = CreateFile(name);
  }
  if (file == NULL) {
    errno = mode[0] == 'r' ? ENOENT : ENOMEM;
    return NULL;
  }
  MemoryStream *stream = calloc(1, sizeof(*stream));
  if (stream == NULL) {
    return NULL;
  }
  stream->file = file;
  stream->writable = mode[0] != 'r' || strchr(mode, '+') != NULL;
  stream->append = mode[0] == 'a';
  if (mode[0] == 'w') {
    file->size = 0;
  }
#ifdef __APPLE__
  FILE *result = funopen(stream, ReadCookie, stream->writable ? WriteCookie : NULL, SeekCookie, CloseMemory);
#else
  cookie_io_functions_t callbacks = { ReadMemory, stream->writable ? WriteMemory : NULL, SeekCookie, CloseMemory };
  FILE *result = fopencookie(stream, mode, callbacks);
#endif
  if (result == NULL) {
    free(stream);
  } else {
    stream->handle = result;
    stream->next = streams;
    streams = stream;
  }
  return result;
}

int destino_remove(const char *name) {
  if (!mounted) {
    return remove(name);
  }
  char path[PATH_MAX];
  int save = SavePath(name, path);
  if (save != 0) {
    return save < 0 ? -1 : remove(path);
  }
  MemoryFile *file = FindFile(name);
  if (file == NULL) {
    errno = ENOENT;
    return -1;
  }
  // Keep storage alive for streams already holding the unlinked file.
  free(file->name);
  file->name = NULL;
  return 0;
}

int destino_rename(const char *old, const char *name) {
  if (!mounted) {
    return rename(old, name);
  }
  char old_path[PATH_MAX];
  char new_path[PATH_MAX];
  int old_save = SavePath(old, old_path);
  int new_save = SavePath(name, new_path);
  if (old_save < 0 || new_save < 0) {
    return -1;
  }
  if (old_save || new_save) {
    if (!old_save || !new_save) {
      errno = EXDEV;
      return -1;
    }
    return rename(old_path, new_path);
  }
  MemoryFile *file = FindFile(old);
  if (file == NULL) {
    errno = ENOENT;
    return -1;
  }
  if (strcmp(old, name) == 0) {
    return 0;
  }
  char *copy = strdup(name);
  if (copy == NULL) {
    return -1;
  }
  if (FindFile(name) != NULL) {
    destino_remove(name);
  }
  free(file->name);
  file->name = copy;
  return 0;
}

int destino_mkdir(const char *path, mode_t mode) {
  return mounted ? 0 : mkdir(path, mode);
}

int destino_system(const char *command) {
  // Native error dialogs launch external processes; SEA must not delegate I/O.
  return mounted ? -1 : system(command);
}

int files_mount(const char *name, const void *data, size_t size, const char *save_path) {
  if (save_path == NULL || strlen(save_path) >= sizeof(save_directory)) {
    errno = EINVAL;
    return 0;
  }
  MemoryFile *file = CreateFile(name);
  if (file == NULL) {
    return 0;
  }
  file->data = malloc(size);
  if (file->data == NULL) {
    return 0;
  }
  memcpy(file->data, data, size);
  file->size = size;
  mounted = 1;
  strcpy(save_directory, save_path);
  return 1;
}

void files_shutdown(void) {
  // Close libc streams while their callbacks and backing files are still alive.
  while (streams != NULL) {
    fclose(streams->handle);
  }
  while (files != NULL) {
    MemoryFile *next = files->next;
    free(files->name);
    free(files->data);
    free(files);
    files = next;
  }
  mounted = 0;
  save_directory[0] = '\0';
}

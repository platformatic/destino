// SPDX-License-Identifier: GPL-3.0-or-later

import { spawn } from 'node:child_process'
import { access, mkdir, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DependencyError } from '../errors.js'

const root = resolve(import.meta.dirname, '../..')
const source = resolve(root, 'deps/engine/src')
const temporary = resolve(root, 'tmp/doomgeneric')
// Match the former CMake source list, replacing all upstream sound glue with audio.c.
const sources = `dummy am_map doomdef doomstat dstrings d_event d_items d_iwad d_loop d_main
d_mode d_net f_finale f_wipe g_game hu_lib hu_stuff info i_cdmus i_endoom i_joystick i_scale
i_system i_timer memio m_argv m_bbox m_cheat m_config m_controls m_fixed m_menu m_misc m_random
p_ceilng p_doors p_enemy p_floor p_inter p_lights p_map p_maputl p_mobj p_plats p_pspr p_saveg
p_setup p_sight p_spec p_switch p_telept p_tick p_user r_bsp r_data r_draw r_main r_plane r_segs
r_sky r_things sha1 sounds statdump st_lib st_stuff s_sound tables v_video wi_stuff w_checksum
w_file w_main w_wad z_zone w_file_stdc i_input i_video doomgeneric mus2mid`.split(/\s+/).map(name => resolve(source, `${name}.c`))
sources.push(resolve(root, 'src/native/main.c'), resolve(root, 'src/native/audio.c'), resolve(root, 'src/native/files.c'))

async function run (args) {
  const { promise, resolve: done, reject } = Promise.withResolvers()
  const compiler = process.env.CC || 'clang'
  const child = spawn(compiler, args, { cwd: root, stdio: 'inherit' })
  child.on('error', error => reject(new DependencyError(`${compiler}: ${error.message}`)))
  child.on('close', code => {
    if (code === 0) {
      done()
    } else {
      reject(new DependencyError(`${compiler} exited with code ${code}`))
    }
  })
  await promise
}

async function main () {
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new DependencyError(`Unsupported platform: ${process.platform}`)
  }
  for (const file of sources) {
    await access(file)
  }
  for (const header of ['tsf.h', 'tml.h']) {
    await access(resolve(root, 'deps/audio/src', header))
  }
  await mkdir(temporary, { recursive: true })
  const objects = []
  for (const [index, file] of sources.entries()) {
    console.log(`\x1b[35;1m--> Compiling ${index + 1}/${sources.length}: ${file.slice(root.length + 1)}\x1b[0m`)
    const object = resolve(temporary, `${index}.o`)
    const flags = file === resolve(source, 'i_system.c') ? ['-DI_Quit=doomgeneric_I_Quit'] : []
    // Route upstream informational output to host no-ops without redirecting
    // Node's stdout (which carries Kitty graphics) or changing upstream files.
    if (file.startsWith(`${source}/`)) {
      flags.push('-Dprintf=destino_printf', '-Dputs=destino_puts', '-Dputchar=destino_putchar')
      flags.push('-Dfopen=destino_fopen', '-Dremove=destino_remove', '-Drename=destino_rename',
        '-Dmkdir=destino_mkdir', '-Dsystem=destino_system')
    }
    await run(['-c', '-fPIC', '-ggdb3', '-Os', '-DFEATURE_SOUND', '-I', source,
      '-I', resolve(root, 'deps/audio/src'), ...flags, file, '-o', object])
    objects.push(object)
  }
  const filename = `destino.${process.platform === 'darwin' ? 'dylib' : 'so'}`
  console.log(`\x1b[35;1m--> Linking ${filename}\x1b[0m`)
  const flags = process.platform === 'darwin'
    ? ['-dynamiclib', `-Wl,-install_name,@rpath/${filename}`]
    : ['-shared', '-Wl,-Bsymbolic-functions', '-Wl,-z,defs', `-Wl,-soname,${filename}`]
  await run([...flags, ...objects, '-lm', '-o', resolve(temporary, filename)])
  await rename(resolve(temporary, filename), resolve(root, 'deps/engine', filename))
  console.log(`\x1b[36mReady: deps/engine/${filename}\x1b[0m`)
}

try {
  await main()
} catch (error) {
  console.error(`DESTINO_BUILD: ${error.message}`)
  process.exitCode = 1
}

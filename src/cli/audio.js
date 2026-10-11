import { Audio } from '../audio.js'

export function listAudioDevices () {
  const audio = new Audio(null, { listOnly: true })

  try {
    const version = audio.version
    console.log(`SDL ${Math.floor(version / 1000000)}.${Math.floor(version / 1000) % 1000}.${version % 1000}`)
    console.log(`Library: ${audio.path}`)

    console.log('\nAudio playback devices:')
    if (audio.devices.length === 0) {
      console.log('  No playback devices found.')
    } else {
      for (const device of audio.devices) {
        console.log(`  - ${device.name}`)
      }

      console.log('\nSet audio to the exact device name, or null for the system default.')
    }
  } finally {
    audio.destroy()
  }
}

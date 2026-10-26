// Prints the name of the Mac's default output device — where Jev's voice actually goes.
// Read-only on purpose: the Mac's own Sound setting stays in charge, and Jev never switches it.
// Needs no permission (CoreAudio device names are not protected).
import CoreAudio
import Foundation

var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                                      mScope: kAudioObjectPropertyScopeGlobal,
                                      mElement: kAudioObjectPropertyElementMain)
var id: AudioDeviceID = 0
var size = UInt32(MemoryLayout<AudioDeviceID>.size)
guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id) == noErr, id != 0 else {
  FileHandle.standardError.write("no default output device\n".data(using: .utf8)!)
  exit(1)
}
var nameAddr = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName,
                                          mScope: kAudioObjectPropertyScopeGlobal,
                                          mElement: kAudioObjectPropertyElementMain)
var name: CFString = "" as CFString
var nameSize = UInt32(MemoryLayout<CFString>.size)
guard AudioObjectGetPropertyData(id, &nameAddr, 0, nil, &nameSize, &name) == noErr else {
  FileHandle.standardError.write("could not read the output device's name\n".data(using: .utf8)!)
  exit(1)
}
print(name as String)

## Android (module)
- Android apps = **Kotlin + Jetpack Compose** (agent `android`), never Rust (unless a shared native library is explicitly requested). AGP, Kotlin and Compose versions: checked in the docs, never written from memory.
- Everything goes through the module's Podman toolchain: `oc-android gradle …` (build, tests, lint), `oc-android emulator start|wait|stop|status`, `oc-android adb …`, `oc-android exec …`. Never install an SDK, a JDK or an emulator on the machine. Run these commands from the project root (it is mounted in the container).
- Team: `android` (code, build, tests) then `mobile-tester` (verification on the emulator).

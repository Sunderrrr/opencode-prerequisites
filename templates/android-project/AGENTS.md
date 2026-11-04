# {{name}}

Android **Kotlin + Jetpack Compose** project (no Rust). Global rules (CEO, validation, git) come from `~/.config/opencode/AGENTS.md`.

## Commands (always from the project root)
- Debug build: `oc-android gradle assembleDebug` → `app/build/outputs/apk/debug/app-debug.apk`
- JVM tests: `oc-android gradle testDebugUnitTest`
- Lint: `oc-android gradle lintDebug`
- Emulator: `oc-android emulator start --wait`, then `oc-android gradle installDebug`
- Launch: `oc-android adb shell monkey -p {{package}} -c android.intent.category.LAUNCHER 1`
- Crashes: `oc-android adb logcat -d -s AndroidRuntime:E`
- Toolchain status: `oc-android doctor`; stop: `oc-android emulator stop`

JDK, SDK and Gradle live in the Podman image: install nothing on the machine and do not run `./gradlew` directly.

## Versions (never from memory)
- Check: `oc-versions android` (or `oc-versions --refresh android`), then rebuild and run real tests.
- API 36 image: `compileSdk`/`targetSdk` 36 and **Compose BOM ≤ 2026.06.01**. A newer BOM requires compileSdk 37 (`checkDebugAarMetadata`) and therefore an `oc-android build-image --api 37` image.
- `kotlin` in `gradle/libs.versions.toml` is the Compose Compiler plugin version, aligned with the Kotlin embedded in AGP. Bumping one without the other breaks the build.
- Any version bump is proven by `assembleDebug` + `testDebugUnitTest` + `lintDebug`.

## Architecture
- `ui/`: Compose without business logic. `ViewModel` + `StateFlow` with immutable state, unidirectional data flow.
- `ui/`, `domain/`, `data/` layers; dependency injection (Hilt or Koin, whichever the project uses).
- Hoisted state, `remember`/`derivedStateOf` where appropriate, `LazyColumn` with stable keys (`key =`).
- Coroutines and `Flow`; `viewModelScope`; no blocking work on the main thread; `WorkManager` for deferred work.

## UI
- Material 3, light/dark themes (already wired to the system), dynamic sizes, edge-to-edge (already enabled).
- Accessibility: `contentDescription` on images, touch targets ≥ 48 dp, sufficient contrast.
- Rotation and foldables: no lost state, `rememberSaveable` where useful.

## Data and security
- Room with versioned, tested migrations; DataStore rather than SharedPreferences; Coil for images.
- Minimal permissions, requested at runtime; components not exported by default; no cleartext HTTP traffic.
- No secret or keystore in the repository (`local.properties`, `keystore.properties`, `*.jks` are ignored). Signing read from the environment.

## Tests
- Every piece of logic (ViewModel, repository, pure function) has a JVM test. A bug = a test that fails first, then the fix.
- UI: Compose instrumented tests (`oc-android gradle connectedDebugAndroidTest`) when the emulator is available.

## Lessons
<!-- /learn adds rules learned from past mistakes here, one per line -->

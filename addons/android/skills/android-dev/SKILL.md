---
name: android-dev
description: Develop and test an Android app with the module's Podman toolchain (oc-android): Gradle, tests, headless emulator, adb, logcat, signing. Use before building, running or testing an Android app.
---
## Principle
JDK, Android SDK, Gradle and the emulator live in a Podman image (`localhost/oc-android`); nothing is installed on the machine. **Run every command from the project root**: that directory is mounted in the container. Check the state with `oc-android doctor` (rootless Podman, image, `/dev/kvm`, emulator). If the image is missing, it is up to the user to build it (`oc-android build-image --accept-licenses`, they accept the SDK licenses): do not build it yourself.

## Versions and image
- Default image: **API 36** (`platforms;android-36`), **JDK 17**; build-tools and Gradle are discovered at build time from the official repositories (at test time: build-tools 37.0.0, Gradle 9.8.2). Check the installed API: `oc-android exec sdkmanager --list_installed`.
- **With the API 36 image, use compileSdk 36 and Compose BOM ≤ 2026.06.01**: a newer BOM (e.g. 2026.09.00) fails at `checkDebugAarMetadata` ("requires compile against version 37 or later"). For a newer BOM: `oc-android build-image --accept-licenses --api 37` (the user has to do it).
- Reference project validated end to end on this image: AGP 9.5.0, Kotlin 2.2.10, Compose BOM 2026.06.01, activity-compose 1.13.0, minSdk 24, compileSdk/targetSdk 36.
- These are starting points, not fixed truths: re-check the versions in the docs (context7, developer.android.com) for every new project instead of copying them.

## Build and tests (Gradle)
- `oc-android gradle assembleDebug` (APK: `app/build/outputs/apk/debug/`) · `oc-android gradle testDebugUnitTest` · `oc-android gradle lintDebug` · `oc-android gradle check`.
- One specific test: `oc-android gradle testDebugUnitTest --tests "com.example.MyClassTest"`. Reports: `app/build/reports/`.
- Failed build: rerun with `--stacktrace` then `--info`; dependencies: `oc-android gradle :app:dependencies --configuration debugRuntimeClasspath`.
- New project without a wrapper: `oc-android gradle wrapper` (uses the image's Gradle), then the AGP/Kotlin/Compose versions come from the docs, not from memory.
- Other SDK tools: `oc-android exec sdkmanager --list`, `oc-android exec avdmanager list avd`.

## Emulator (headless, requires /dev/kvm)
- Start: `oc-android emulator start --wait` (mounts the current directory read-only so APKs can be installed; `--mount DIR` for another directory). First start takes longer (AVD creation). Status: `oc-android emulator status`; container logs: `oc-android emulator logs`; stop: `oc-android emulator stop`.
- If `/dev/kvm` is inaccessible, the emulator is unusable: say so (`kvm` group, virtualization enabled in the BIOS); do not attempt software emulation.

## adb, install, launch, logs
- `oc-android adb devices` · install: `oc-android adb install -r app/build/outputs/apk/debug/app-debug.apk` (or `oc-android gradle installDebug`) · launch: `oc-android adb shell monkey -p <package> -c android.intent.category.LAUNCHER 1`.
- Crashes: `oc-android adb logcat -d -s AndroidRuntime:E`; clear before a test: `oc-android adb logcat -c`; app data: `oc-android adb shell pm clear <package>`.
- Instrumented tests (emulator running): `oc-android gradle connectedDebugAndroidTest`.
- The `mobile_*` MCP tools (if available) use this same emulator.

## Release (only if asked)
- Keystore and passwords OUTSIDE the repository (environment variables or a git-ignored `keystore.properties`). `oc-android gradle bundleRelease` (AAB); test the release APK on the emulator, R8 can break code.

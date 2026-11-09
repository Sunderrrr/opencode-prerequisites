# Android end-to-end test

`scripts/e2e-android.sh` validates the whole Android module on real hardware: rootless
Podman, the `localhost/oc-android:latest` image, a real KVM emulator, a generated
Kotlin/Compose project, a debug APK, installation, launch, crash log and screenshot.
It complements `scripts/test-android.mjs`, which uses a fake Podman and never boots an
emulator.

**Validated on 2026-11-09** on Linux x86_64 (rootless Podman 6.1.4, `/dev/kvm`, image
`localhost/oc-android:latest`, Android 16 / API 36): 11/11 steps passed in 112 s on a warm
host, debug APK 11,501,075 bytes, screenshot 1080×2400 PNG (30,911 bytes), no
`AndroidRuntime:E` entry.

## What the script does

1. Resolves `oc-android` and `oc-new-android` from `PATH`, or from this checkout
   (`addons/android/bin/oc-android`, `config/bin/oc-new-android`) when the kit is not
   installed. A checkout without `<config>/android` gets a temporary config containing the
   `Containerfile` and `discover.mjs`.
2. Checks rootless Podman (`podman info`) and an accessible `/dev/kvm`.
3. Builds the image only when it is missing **and** `OC_ANDROID_ACCEPT_LICENSES=1`
   (the flag means you accept the Android SDK licenses). Otherwise it stops with the exact
   command to run.
4. Runs `oc-android doctor` and asserts that the image and `/dev/kvm` are reported as usable.
5. Starts the emulator with `oc-android emulator start --wait` (headless, hardware
   acceleration, no software fallback).
6. Generates a project with `oc-new-android <name>` in the artifacts directory.
7. Runs `oc-android gradle assembleDebug`, checks the APK exists and is non-empty, then
   installs it with the real Gradle `installDebug` task. AGP's ddmlib always connects to
   `127.0.0.1:5037` and ignores `ADB_SERVER_SOCKET`, while the emulator's adb server is on
   the `oc-android` network: the script runs `./gradlew installDebug` in an
   `oc-android exec` container through a small Perl TCP proxy to that server. This keeps the
   official Gradle install task instead of falling back to `adb install`.
8. Clears logcat, launches `com.example.<name>/.MainActivity` with `am start -W`, checks
   `Status: ok`, waits a few seconds, checks the process is alive and that
   `adb logcat -d -s AndroidRuntime:E` has no entry.
9. Captures `adb exec-out screencap -p` and checks the PNG magic bytes and size.
10. Stops the emulator and prints a per-step summary.

Any failing command aborts the run, prints the failing step, and stops the emulator in an
exit trap. The emulator is also stopped if the script is interrupted.

## Prerequisites

- **Linux x86_64 with hardware virtualization**: `/dev/kvm` must exist and be readable and
  writable by the user running the script. On most distributions, add the user to the `kvm`
  group and log back in. Without KVM the script fails instead of running a slow software
  emulator.
- **Rootless Podman**: `podman info` must succeed; `/etc/subuid` and `/etc/subgid` must
  contain a range for the user. Rootful Podman is not tested.
- **Android module**: `./install.sh --android`, or a checkout (the fallback above). The
  `oc-android` and `oc-new-android` commands must be executable.
- **Image**: `localhost/oc-android:latest`, built once with
  `oc-android build-image --accept-licenses` (10–20 min, several GB). The image contains
  JDK 17, the Android SDK, Gradle and the emulator. Building it downloads from
  `dl.google.com` and `services.gradle.org` and checks the official SHA-1/SHA-256.
- **Licenses**: the Android SDK licenses are accepted by **you**, not by the test. The
  script never passes `--accept-licenses` unless `OC_ANDROID_ACCEPT_LICENSES=1`.
- **Disk and network**: about 10 GB for the image and the Gradle caches, and network access
  on the first `assembleDebug` (Maven dependencies). Later builds reuse
  `~/.cache/oc-android/gradle`.
- **Node.js 18+** only if the image has to be built (`oc-android build-image` runs
  `discover.mjs`). CI uses Node 26.

## Run locally

```bash
./install.sh --android
oc-android build-image --accept-licenses    # once; you accept the SDK licenses
oc-android doctor
scripts/e2e-android.sh
```

To let the script build a missing image itself:

```bash
OC_ANDROID_ACCEPT_LICENSES=1 scripts/e2e-android.sh
```

Useful variables:

| Variable | Default | Effect |
| --- | --- | --- |
| `OC_ANDROID_ACCEPT_LICENSES` | unset | `1` allows `build-image --accept-licenses` when the image is missing |
| `OC_ANDROID_E2E_ARTIFACTS` | `$TMPDIR/opencode/android-e2e-<date>-<pid>` | artifacts directory; always kept when set explicitly |
| `OC_ANDROID_E2E_KEEP` | `0` | `1` keeps the default artifacts directory after a successful run; a failed run is always kept |
| `OC_ANDROID_E2E_PROJECT_NAME` | `e2e-demo` | generated project name (`com.example.<name>`) |
| `OC_ANDROID_E2E_BUILD_TIMEOUT` | `1800` | `assembleDebug` timeout, seconds |
| `OC_ANDROID_E2E_INSTALL_TIMEOUT` | `600` | `installDebug` timeout, seconds |
| `OC_ANDROID_E2E_BUILD_IMAGE_TIMEOUT` | `2400` | image build timeout, seconds |
| `OC_ANDROID_E2E_LAUNCH_WAIT` | `8` | seconds between `am start` and the checks |
| `OC_ANDROID_IMAGE` | `localhost/oc-android:latest` | image to use and check |
| `OC_ANDROID_KVM` | `/dev/kvm` | KVM device |
| `OC_ANDROID_EMU` | `oc-android-emu` | emulator container name (also the proxy target) |
| `OC_PODMAN` | `podman` | Podman binary |
| `OPENCODE_CONFIG_DIR` | `~/.config/opencode` | installation providing `android/Containerfile` |

The artifacts directory contains the generated project (including `app/build/outputs/apk/debug/app-debug.apk`)
and `screenshot.png`. On success the script prints `✅ Android E2E passed: <project>`; the
exit code is 0 only if every step passed.

Expected duration on a warm host: 3–8 minutes (emulator boot dominates). The first build
after a cache wipe can take 10–20 minutes.

## CI job

`.github/workflows/ci-android-e2e.yml` runs on `workflow_dispatch` and weekly
(Monday 04:43 UTC). It targets:

```yaml
runs-on: [self-hosted, linux, x64, kvm]
```

GitHub-hosted runners do not expose `/dev/kvm`, so the job cannot run there. The
self-hosted runner must be provisioned with:

- the `self-hosted`, `linux`, `x64` and `kvm` labels (the `kvm` label is a convention: it
  says the machine really has `/dev/kvm` and Podman);
- rootless Podman with subuid/subgid, and an accessible `/dev/kvm` for the runner user;
- the `localhost/oc-android:latest` image (prebuild it; do not rely on the job);
- network access for Gradle dependencies, and enough disk for the image and caches;
- optionally the kit installed with `--android`; otherwise the job uses the checkout
  fallback.

The workflow sets `OC_ANDROID_E2E_ARTIFACTS` under `$RUNNER_TEMP`, keeps the artifacts and
uploads them (screenshot, generated project, build outputs) with
`actions/upload-artifact@v7` even when the job fails. `timeout-minutes: 60` covers emulator
boot, Gradle download and installation.

If the runner is allowed to build the image, set the repository variable
`OC_ANDROID_ACCEPT_LICENSES=1`; otherwise leave it unset and prebuild the image. The
variable does not accept licenses for you: it only allows the script to pass
`--accept-licenses`.

## Limits

- **x86_64 only**: the image ships an x86_64 system image; ARM hosts and Apple Silicon are
  not covered.
- **No software emulation**: the script requires KVM and fails clearly without it.
- **Default image is API 36**: the generated project uses `compileSdk 36` and a Compose BOM
  compatible with API 36. For API 37, rebuild the image with
  `oc-android build-image --accept-licenses --api 37` and update the template constraints.
- **Screenshot is a smoke check**: PNG magic and non-empty file, not a pixel or UI
  assertion. Visual and accessibility checks belong to the `mobile-tester` agent /
  `mobile-mcp`, not to this script.
- **Logcat scope**: only `AndroidRuntime:E` is checked, after the buffer is cleared. Native
  crashes (tombstones) and ANRs are not asserted.
- **`installDebug` proxy**: the local TCP proxy relies on Perl, which the Ubuntu-based image
  provides. It only bridges `127.0.0.1:5037` to the emulator container; no Gradle task or
  APK is mocked. A future `oc-android` release could expose a native local-adb mode and
  remove the proxy.
- **No physical device and no iOS**: this is the Podman emulator path only.
- **Trusted runner**: the script mounts the project into containers and uses the Docker
  socket-free Podman network; do not run it on an untrusted shared machine.
- **Network**: the first image build and the first Gradle build need network access;
  subsequent runs can work offline only if the caches are warm.

## Troubleshooting

```bash
oc-android doctor                 # Podman, image, KVM, emulator, fake adb
oc-android emulator status
oc-android emulator logs          # emulator container logs
podman info                       # rootless mode and storage
ls -l /dev/kvm                    # permissions; kvm group
```

- `Podman is not responding in rootless mode`: check `/etc/subuid`, `/etc/subgid` and
  `podman info` after a fresh login.
- `Image ... is missing`: run `oc-android build-image --accept-licenses` once, or set
  `OC_ANDROID_ACCEPT_LICENSES=1`.
- `Android did not finish booting`: inspect `oc-android emulator logs`; the first boot
  creates the AVD and can be slow on a busy host.
- `am start did not report Status: ok`: check the package name in
  `app/build.gradle.kts` and the activity in `AndroidManifest.xml`.
- `AndroidRuntime errors found`: the crash trace is printed before the failure; the APK and
  project are kept in the artifacts directory.

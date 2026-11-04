## Android module (installed)
| Specialist | When to call it |
|---|---|
| `@android` | Android app: Kotlin, Jetpack Compose, Gradle, tests; commands through `oc-android` (Podman) |
| `@mobile-tester` | verify the app on the emulator (user flows, crashes); read-only |

- **Android app** → `@android` to build and test, then `@mobile-tester` to check the UI on the emulator (`oc-android emulator start --wait`), then `@verify-app`. No Rust for an Android app: Kotlin.

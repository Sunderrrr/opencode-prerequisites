## Module Android (installé)
| Spécialiste | Quand l'appeler |
|---|---|
| `@android` | application Android : Kotlin, Jetpack Compose, Gradle, tests ; commandes via `oc-android` (Podman) |
| `@mobile-tester` | vérifier l'application sur l'émulateur (parcours, crashs) ; lecture seule |

- **Application Android** → `@android` pour construire et tester, puis `@mobile-tester` pour vérifier l'interface sur l'émulateur (`oc-android emulator start --wait`), puis `@verify-app`. Pas de Rust pour une app Android : Kotlin.

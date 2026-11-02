## Android (module)
- Applications Android = **Kotlin + Jetpack Compose** (agent `android`), jamais Rust (sauf bibliothèque native partagée demandée). Versions d'AGP, Kotlin et Compose : vérifiées dans la doc, jamais écrites de mémoire.
- Tout passe par le toolchain Podman du module : `oc-android gradle …` (build, tests, lint), `oc-android emulator start|wait|stop|status`, `oc-android adb …`, `oc-android exec …`. N'installe jamais de SDK, de JDK ni d'émulateur sur la machine. Lance ces commandes depuis la racine du projet (elle est montée dans le conteneur).
- Équipe : `android` (code, build, tests) puis `mobile-tester` (vérification sur l'émulateur).

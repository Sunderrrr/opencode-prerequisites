---
name: android-dev
description: Développer et tester une application Android avec le toolchain Podman du module (oc-android) : Gradle, tests, émulateur sans fenêtre, adb, logcat, signature. À utiliser avant de construire, lancer ou tester une app Android.
---
## Principe
JDK, SDK Android, Gradle et émulateur vivent dans une image Podman (`localhost/oc-android`) ; rien n'est installé sur la machine. **Lance toutes les commandes depuis la racine du projet** : ce dossier est monté dans le conteneur. Vérifie l'état avec `oc-android doctor` (Podman rootless, image, `/dev/kvm`, émulateur). Si l'image est absente, c'est à l'utilisateur de la construire (`oc-android build-image --accept-licenses`, il accepte les licences du SDK) : ne la construis pas toi-même.

## Versions et image
- Image par défaut : **API 36** (`platforms;android-36`), **JDK 17** ; build-tools et Gradle sont découverts à la construction depuis les dépôts officiels (au moment du test : build-tools 37.0.0, Gradle 9.8.2). Vérifie l'API installée : `oc-android exec sdkmanager --list_installed`.
- **Avec l'image API 36, compileSdk 36 et Compose BOM ≤ 2026.06.01** : un BOM plus récent (ex. 2026.09.00) échoue à `checkDebugAarMetadata` (« requires compile against version 37 or later »). Pour un BOM plus récent : `oc-android build-image --accept-licenses --api 37` (à l'utilisateur de le faire).
- Projet de référence validé de bout en bout sur cette image : AGP 9.5.0, Kotlin 2.2.10, Compose BOM 2026.06.01, activity-compose 1.13.0, minSdk 24, compileSdk/targetSdk 36.
- Ce sont des points de départ, pas des vérités figées : re-vérifie les versions dans la doc (context7, developer.android.com) à chaque nouveau projet au lieu de les recopier.

## Build et tests (Gradle)
- `oc-android gradle assembleDebug` (APK : `app/build/outputs/apk/debug/`) · `oc-android gradle testDebugUnitTest` · `oc-android gradle lintDebug` · `oc-android gradle check`.
- Un test précis : `oc-android gradle testDebugUnitTest --tests "com.exemple.MaClasseTest"`. Rapports : `app/build/reports/`.
- Build en échec : relancer avec `--stacktrace` puis `--info` ; dépendances : `oc-android gradle :app:dependencies --configuration debugRuntimeClasspath`.
- Nouveau projet sans wrapper : `oc-android gradle wrapper` (utilise le Gradle de l'image), puis les versions d'AGP/Kotlin/Compose viennent de la doc, pas de la mémoire.
- Autres outils du SDK : `oc-android exec sdkmanager --list`, `oc-android exec avdmanager list avd`.

## Émulateur (sans fenêtre, exige /dev/kvm)
- Démarrer : `oc-android emulator start --wait` (monte le dossier courant en lecture seule pour installer des APK ; `--mount DIR` pour un autre dossier). Premier démarrage plus long (création de l'AVD). État : `oc-android emulator status` ; logs du conteneur : `oc-android emulator logs` ; arrêt : `oc-android emulator stop`.
- Si `/dev/kvm` est inaccessible, l'émulateur est inutilisable : dis-le (groupe `kvm`, virtualisation activée dans le BIOS) ; ne tente pas l'émulation logicielle.

## adb, installation, lancement, logs
- `oc-android adb devices` · installer : `oc-android adb install -r app/build/outputs/apk/debug/app-debug.apk` (ou `oc-android gradle installDebug`) · lancer : `oc-android adb shell monkey -p <package> -c android.intent.category.LAUNCHER 1`.
- Crashs : `oc-android adb logcat -d -s AndroidRuntime:E` ; effacer avant un test : `oc-android adb logcat -c` ; données de l'app : `oc-android adb shell pm clear <package>`.
- Tests instrumentés (émulateur démarré) : `oc-android gradle connectedDebugAndroidTest`.
- Les outils MCP `mobile_*` (si présents) utilisent ce même émulateur.

## Release (seulement si demandé)
- Keystore et mots de passe HORS du dépôt (variables d'environnement ou `keystore.properties` ignoré par git). `oc-android gradle bundleRelease` (AAB) ; tester l'APK release sur l'émulateur, R8 peut casser du code.

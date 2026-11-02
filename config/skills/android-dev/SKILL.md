---
name: android-dev
description: Environnement et commandes pour développer une application Android en ligne de commande : SDK, émulateur (AVD), adb, Gradle, tests, logcat, signature. À utiliser avant de construire, lancer ou tester une app Android.
---
## Environnement (à vérifier d'abord)
- JDK 17+ (`java -version`). SDK Android : `ANDROID_HOME` (souvent `~/Android/Sdk`) avec `platform-tools` (adb), `emulator`, `cmdline-tools/latest/bin` (sdkmanager, avdmanager), `platforms;android-<n>`, `build-tools;<v>`.
- Linux : l'émulateur exige l'accélération matérielle (`/dev/kvm` accessible par ton utilisateur : groupe `kvm`). Sans KVM, l'émulateur est inutilisable : dis-le.
- `./doctor.sh` du kit affiche l'état de tout cela. Ne télécharge pas de SDK sans demande : les licences Android doivent être acceptées par l'utilisateur (`sdkmanager --licenses`).

## Émulateur et appareils
- Lister : `emulator -list-avds` ; `adb devices`.
- Créer (seulement si demandé) : `avdmanager create avd -n test -k "system-images;android-<n>;google_apis;x86_64"` (image à installer avec `sdkmanager`).
- Démarrer sans fenêtre : `emulator -avd <nom> -no-window -no-audio -gpu swiftshader_indirect &` puis `adb wait-for-device` et attendre `adb shell getprop sys.boot_completed` = `1`.
- Arrêter : `adb emu kill`.

## Construire, installer, lancer
- Build : `./gradlew assembleDebug` ; installation : `./gradlew installDebug` ; APK : `app/build/outputs/apk/debug/`.
- Lancer : `adb shell monkey -p <package> -c android.intent.category.LAUNCHER 1` (ou `am start -n <package>/<activité>`).
- Effacer les données : `adb shell pm clear <package>` ; désinstaller : `adb uninstall <package>`.

## Tests et qualité
- Unitaires : `./gradlew testDebugUnitTest` (rapports dans `app/build/reports/tests/`). Un test précis : `--tests "com.exemple.MaClasseTest"`.
- Instrumentés (appareil requis) : `./gradlew connectedDebugAndroidTest`.
- Lint : `./gradlew lintDebug` ; vérification globale : `./gradlew check`.
- Un build qui échoue : relancer avec `--stacktrace` puis `--info` ; dépendances : `./gradlew :app:dependencies --configuration debugRuntimeClasspath` ; nettoyer en dernier recours : `./gradlew clean`.

## Logs et crashs
- Erreurs : `adb logcat -d -s AndroidRuntime:E` ; par application : `adb logcat -d --pid=$(adb shell pidof -s <package>)`.
- Vider avant un test : `adb logcat -c`. Captures : `adb exec-out screencap -p > ecran.png`.

## Release (seulement si demandé)
- Signature : keystore HORS du dépôt, mot de passe via variables d'environnement ou `keystore.properties` ignoré par git. `./gradlew bundleRelease` (AAB pour le Play Store) ; vérifier que R8 ne casse rien (tester l'APK release sur appareil).

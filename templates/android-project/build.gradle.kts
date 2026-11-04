// Plugins declared here, applied in app/build.gradle.kts.
// AGP 9 embeds Kotlin: only the Compose compiler plugin is added.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.compose.compiler) apply false
}

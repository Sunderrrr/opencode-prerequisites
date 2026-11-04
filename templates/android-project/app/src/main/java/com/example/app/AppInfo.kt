package {{package}}

/**
 * Stable values shared by the UI and the JVM tests.
 * The title is checked by AppInfoTest: it proves that generation substituted the name.
 */
object AppInfo {
    const val TITLE = "{{app_title}}"
    const val TEST_TAG = "app_title"
}

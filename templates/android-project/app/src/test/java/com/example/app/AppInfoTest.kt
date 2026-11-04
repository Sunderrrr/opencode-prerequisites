package {{package}}

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AppInfoTest {
    @Test
    fun titleComesFromProjectName() {
        assertEquals("{{app_title}}", AppInfo.TITLE)
    }

    @Test
    fun titleIsDisplayable() {
        assertTrue(AppInfo.TITLE.isNotBlank())
    }

    @Test
    fun testTagIsStable() {
        assertEquals("app_title", AppInfo.TEST_TAG)
    }
}

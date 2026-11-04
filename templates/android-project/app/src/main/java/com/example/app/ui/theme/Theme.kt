package {{package}}.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Minimal Material 3 color set. Replace with dynamicLightColorScheme /
// dynamicDarkColorScheme on API 31+ when the product should follow the wallpaper.
private val LightColors = lightColorScheme(primary = Color(0xFF3F5F90))
private val DarkColors = darkColorScheme(primary = Color(0xFFA8C7FA))

@Composable
fun AppTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content,
    )
}

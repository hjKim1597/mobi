package dev.mobi.ui

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import kotlin.math.pow
import org.junit.Assert.*
import org.junit.Test

class QuietMailSettingStyleTest {
    private fun resources(path: String, kind: String): Map<String, String> {
        val nodes = DocumentBuilderFactory.newInstance().newDocumentBuilder()
            .parse(File("src/main/res/$path")).getElementsByTagName(kind)
        return (0 until nodes.length).associate { index ->
            val node = nodes.item(index)
            node.attributes.getNamedItem("name").nodeValue to node.textContent.trim()
        }
    }

    @Test fun usesCarTouchTargetAndExistingBodyAndDescriptionSizesWithoutNightOverrides() {
        val dimensions = resources("values/quiet_setting.xml", "dimen")
        assertTrue(dimensions.getValue("quiet_setting_min_height").removeSuffix("dp").toFloat() >= 76f)
        assertEquals("32sp", dimensions["quiet_setting_label_size"])
        assertEquals("24sp", dimensions["quiet_setting_description_size"])
        for (directory in File("src/main/res").listFiles().orEmpty().filter { it.name.startsWith("values-night") }) {
            for (file in directory.listFiles().orEmpty().filter { it.extension == "xml" }) {
                val overridden = resources("${directory.name}/${file.name}", "dimen").keys
                assertTrue("Theme must not resize the row: ${file.name}", dimensions.keys.intersect(overridden).isEmpty())
            }
        }
    }

    @Test fun actualDayAndNightTokensKeepTextAndSwitchContrast() {
        fun luminance(hex: String): Double {
            val value = hex.removePrefix("#").toLong(16)
            fun channel(shift: Int): Double {
                val n = ((value shr shift) and 255).toDouble() / 255
                return if (n <= 0.04045) n / 12.92 else ((n + 0.055) / 1.055).pow(2.4)
            }
            return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
        }
        fun contrast(a: String, b: String): Double {
            val x = luminance(a); val y = luminance(b)
            return (maxOf(x, y) + 0.05) / (minOf(x, y) + 0.05)
        }
        for (mode in listOf("values", "values-night")) {
            val colors = resources("$mode/colors.xml", "color")
            val surface = colors.getValue("pleos_surface")
            for (text in listOf("pleos_text", "pleos_secondary")) {
                assertTrue("$mode $text", contrast(colors.getValue(text), surface) >= 4.5)
            }
            assertTrue("$mode switch track", contrast(colors.getValue("pleos_active"), surface) >= 3.0)
            assertTrue("$mode checked thumb", contrast("#FFFFFF", colors.getValue("pleos_active")) >= 3.0)
        }
    }
}

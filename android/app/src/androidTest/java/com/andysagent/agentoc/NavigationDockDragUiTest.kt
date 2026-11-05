package com.andysagent.agentoc

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.agentoc.core.designsystem.*
import com.andysagent.agentoc.core.navigation.*
import com.andysagent.agentoc.core.agentui.AgentConnectionStatus
import com.andysagent.agentoc.core.model.Project
import com.andysagent.agentoc.core.model.Session
import com.andysagent.agentoc.feature.workbench.*
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class NavigationDockDragUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private var selected by mutableStateOf(AgentoDestination.Home)
    private val selections = mutableListOf<AgentoDestination>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val dark get() = InstrumentationRegistry.getArguments().getString("dark") == "true"
    private fun show(direction: LayoutDirection = LayoutDirection.Ltr, policy: MotionPreference = MotionPreference.Full,
        actualPages: Boolean = false) {
        rule.setContent { CompositionLocalProvider(LocalLayoutDirection provides direction) {
            AgentocTheme(darkTheme = dark, motionPreference = policy) {
                if (actualPages) WorkbenchScreen(WorkbenchUiState(destination = selected,
                    connection = AgentConnectionStatus.Connected,
                    projects = listOf(Project("p", "产品设计")),
                    sessions = listOf(Session("s", "检查移动端体验", "p"))), onEvent = {
                    if (it is WorkbenchEvent.SelectDestination) { selections += it.destination; selected = it.destination }
                }) else AgentoSurface(Modifier.fillMaxSize()) {
                    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = androidx.compose.ui.Alignment.BottomCenter) {
                        AgentoBottomNavigation(selected, { selections += it; selected = it }, onCreateProject = {})
                    }
                }
            }
        } }
        rule.waitForIdle()
        selections.clear()
    }
    private fun shell() = rule.onNodeWithTag("bottom-navigation-shell")
    private fun capture(name: String) {
        rule.waitForIdle()
        val file = File(instrumentation.targetContext.getExternalFilesDir(null), "navigation-drag/$name-$dark.png")
        file.parentFile?.mkdirs()
        instrumentation.uiAutomation.takeScreenshot().let { bitmap ->
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }
    private fun assertCentered(destination: AgentoDestination, rtl: Boolean = false) {
        val bounds = shell().fetchSemanticsNode().boundsInRoot
        val lens = rule.onNodeWithTag("bottom-navigation-selection").fetchSemanticsNode().boundsInRoot
        val slot = if (rtl) 2 - destination.ordinal else destination.ordinal
        assertEquals(bounds.left + bounds.width * (slot + .5f) / 3f, lens.center.x, 2f)
    }

    @Test fun draggingFollowsFingerAndCommitsOnlyOnReleaseInRealPages() {
        show(actualPages = true)
        capture("resting")
        shell().performTouchInput { down(center) }
        capture("pressed")
        shell().performTouchInput { moveTo(Offset(width * .70f, centerY), 160) }
        rule.runOnIdle { assertEquals(AgentoDestination.Home, selected); assertTrue(selections.isEmpty()) }
        val bounds = shell().fetchSemanticsNode().boundsInRoot
        val lens = rule.onNodeWithTag("bottom-navigation-selection").fetchSemanticsNode().boundsInRoot
        assertEquals(bounds.left + bounds.width * .70f, lens.center.x, 2f)
        capture("dragging")
        shell().performTouchInput { moveTo(Offset(width * 5f / 6f, centerY), 100); up() }
        rule.waitForIdle()
        rule.runOnIdle { assertEquals(AgentoDestination.Settings, selected); assertEquals(1, selections.count { it == AgentoDestination.Settings }) }
        assertCentered(AgentoDestination.Settings)
        capture("released")
        rule.onNodeWithTag("bottom-navigation-tab-home").performClick()
        rule.waitForIdle()
        assertCentered(AgentoDestination.Home)
    }

    @Test fun contactContourRespondsToTouchLocationWithoutChangingHitArea() {
        show(actualPages = true)
        val lens = rule.onNodeWithTag("bottom-navigation-selection")
        val original = lens.fetchSemanticsNode().boundsInRoot
        val shellBounds = shell().fetchSemanticsNode().boundsInRoot
        fun press(fraction: Float) {
            shell().performTouchInput {
                down(Offset(original.left - shellBounds.left + original.width * fraction,
                    original.top - shellBounds.top + original.height * .18f))
            }
            rule.waitForIdle()
        }
        press(.22f)
        capture("contact-left")
        val left = lens.captureToImage().toPixelMap()
        assertEquals(original, lens.fetchSemanticsNode().boundsInRoot)
        shell().performTouchInput { cancel() }
        rule.waitForIdle()
        press(.78f)
        capture("contact-right")
        val right = lens.captureToImage().toPixelMap()
        assertEquals(original, lens.fetchSemanticsNode().boundsInRoot)
        // Both presses have identical tone. Different edge pixels must come
        // from a contour that follows the contact, not uniform scale or tint.
        var leftDifference = 0f
        var rightDifference = 0f
        for (y in 0 until (left.height * .20f).toInt()) {
            for (x in (left.width * .18f).toInt() until (left.width * .40f).toInt())
                leftDifference += kotlin.math.abs(left[x, y].red - right[x, y].red)
            for (x in (left.width * .60f).toInt() until (left.width * .82f).toInt())
                rightDifference += kotlin.math.abs(left[x, y].red - right[x, y].red)
        }
        assertTrue("Left edge should respond to contact location: $leftDifference", leftDifference > 2f)
        assertTrue("Right edge should respond to contact location: $rightDifference", rightDifference > 2f)
        shell().performTouchInput { cancel() }
        rule.waitForIdle()
        rule.runOnIdle { assertTrue(selections.isEmpty()) }
        assertCentered(AgentoDestination.Home)
        capture("contact-restored")
    }

    @Test fun draggingOutOfDockCancelsWithoutNavigation() {
        show()
        shell().performTouchInput {
            down(center); moveTo(Offset(width * .8f, centerY), 120)
            moveTo(Offset(width * .8f, -height * 2f), 120); up()
        }
        rule.waitForIdle()
        rule.runOnIdle { assertEquals(AgentoDestination.Home, selected); assertTrue(selections.isEmpty()) }
        assertCentered(AgentoDestination.Home)
    }

    @Test fun cancelledPointerAndReturningToStartDoNotSwitch() {
        show()
        shell().performTouchInput { down(center); moveTo(Offset(width * .8f, centerY), 120); cancel() }
        rule.waitForIdle()
        assertCentered(AgentoDestination.Home)
        shell().performTouchInput {
            down(center); moveTo(Offset(width * .8f, centerY), 100); moveTo(center, 100); up()
        }
        rule.waitForIdle()
        rule.runOnIdle { assertTrue(selections.isEmpty()) }
        assertCentered(AgentoDestination.Home)
    }

    @Test fun rtlDragAndNoAnimationPreserveLogicalTabOrder() {
        selected = AgentoDestination.Sessions
        show(direction = LayoutDirection.Rtl, policy = MotionPreference.None)
        shell().performTouchInput {
            down(Offset(width * 5f / 6f, centerY)); moveTo(Offset(width / 6f, centerY), 250); up()
        }
        rule.waitForIdle()
        rule.runOnIdle { assertEquals(listOf(AgentoDestination.Settings), selections) }
        assertCentered(AgentoDestination.Settings, rtl = true)
    }

    @Test fun reducedMotionStillSupportsDragAndAccessibleClick() {
        show(policy = MotionPreference.Reduced)
        shell().performTouchInput { down(center); moveTo(Offset(width / 6f, centerY), 160); up() }
        rule.waitForIdle()
        assertCentered(AgentoDestination.Sessions)
        rule.onNodeWithTag("bottom-navigation-tab-settings").assertHasClickAction().performClick().assertIsSelected()
    }
}

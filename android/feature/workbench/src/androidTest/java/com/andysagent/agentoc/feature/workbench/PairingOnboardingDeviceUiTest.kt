package com.andysagent.agentoc.feature.workbench

import android.content.res.Configuration
import android.graphics.Bitmap
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import java.io.File
import java.io.FileOutputStream
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Static UI evidence only: this fixture never signs in, pairs, or starts a transport. */
@RunWith(AndroidJUnit4::class)
class PairingOnboardingDeviceUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private fun show(state: PairingOnboardingUiState, onEvent: (PairingOnboardingEvent) -> Unit = {}) {
        val configuration = Configuration(rule.activity.resources.configuration).apply {
            setLocale(Locale.SIMPLIFIED_CHINESE)
        }
        val chineseContext = rule.activity.createConfigurationContext(configuration)
        rule.setContent {
            CompositionLocalProvider(LocalContext provides chineseContext) {
                AgentocTheme(darkTheme = false) {
                    PairingOnboardingDialog(state, onEvent, {}, {}, {})
                }
            }
        }
    }

    private fun capture(name: String) {
        rule.waitForIdle()
        // UiAutomation captures the physical display; Compose idleness can precede the
        // platform sheet's entrance animation, leaving a washed-out transition frame.
        Thread.sleep(900)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = checkNotNull(instrumentation.targetContext.getExternalFilesDir("pairing-ui"))
        val file = File(directory, name)
        val screenshot = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        FileOutputStream(file).use { output ->
            check(screenshot.compress(Bitmap.CompressFormat.PNG, 100, output))
        }
        screenshot.recycle()
        assertTrue("Screenshot is empty: ${file.absolutePath}", file.length() > 0)
        Log.i("PairingOnboardingDeviceUiTest", "Saved ${file.absolutePath}")
    }

    @Test fun waitingIsReadableAndStopWaitingHasAnAccessibleAction() {
        var event: PairingOnboardingEvent? = null
        show(PairingOnboardingUiState(open = true, step = PairingOnboardingStep.Verifying)) {
            event = it
        }

        rule.onNodeWithText("正在验证 Google 帐号、关联授权和此设备。").assertIsDisplayed()
        val stopWaiting = rule.onNodeWithText("停止等待").assertIsDisplayed().assertHasClickAction()
        val minimumTouchHeight = 48f * rule.activity.resources.displayMetrics.density
        assertTrue(stopWaiting.fetchSemanticsNode().boundsInRoot.height >= minimumTouchHeight)
        capture("waiting-zh-CN.png")
        rule.onNodeWithText("停止等待").performClick()
        assertEquals(PairingOnboardingEvent.StopWaiting, event)
    }

    @Test fun linkedStateUsesChineseCopy() {
        var event: PairingOnboardingEvent? = null
        show(PairingOnboardingUiState(open = true, step = PairingOnboardingStep.Bound)) {
            event = it
        }
        rule.onNodeWithText("已连接").assertIsDisplayed()
        rule.onNodeWithText("这台电脑已关联到 Google 帐号。以后连接时无需再扫码。")
            .assertIsDisplayed()
        rule.onNodeWithText("关闭").assertIsDisplayed().assertHasClickAction()
        rule.onNodeWithText("取消").assertDoesNotExist()
        capture("linked-zh-CN.png")
        rule.onNodeWithText("关闭").performClick()
        assertEquals(PairingOnboardingEvent.Dismiss, event)
    }

    @Test fun rejectedCodeShowsNewCodeAction() {
        show(PairingOnboardingUiState(
            open = true,
            step = PairingOnboardingStep.Error,
            errorMessage = "The computer could not accept this account-link request.",
            errorMessageRes = R.string.pairing_error_request_conflict,
            requiresNewCode = true,
        ))
        rule.onNodeWithText("重新开始").assertIsDisplayed().assertHasClickAction()
        rule.onNodeWithText("此配对码不能重复使用。请从电脑获取新码并重新开始。")
            .assertIsDisplayed()
        rule.onNodeWithText("The computer could not accept this account-link request.")
            .assertDoesNotExist()
        capture("rejected-code-zh-CN.png")
    }

    @Test fun actionRowRemainsVisibleWithKeyboardOpen() {
        show(PairingOnboardingUiState(open = true, step = PairingOnboardingStep.ComputerAliasRequired))
        rule.onNode(hasSetTextAction()).performClick()
        rule.waitUntil(5_000) {
            ViewCompat.getRootWindowInsets(rule.activity.window.decorView)
                ?.isVisible(WindowInsetsCompat.Type.ime()) == true
        }
        rule.onNodeWithText("取消").assertIsDisplayed().assertHasClickAction()
        rule.onNodeWithText("关联电脑").assertIsDisplayed().assertHasClickAction()
        capture("keyboard-zh-CN.png")
    }
}

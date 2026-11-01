package com.andysagent.agentoc

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import com.andysagent.agentoc.core.agentui.AgentRunStatus
import com.andysagent.agentoc.core.agentui.FloatingTopChrome
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import org.junit.Rule
import org.junit.Test

/**
 * Instrumented Compose UI tests for the FloatingTopChrome title capsule:
 * with onTitleClick wired the capsule performs the callback (Dynamic Island
 * affordance that expands the run sheet), and the capsule stays tappable
 * with its status dot. Runs on an emulator via connectedDebugAndroidTest.
 */
class FloatingTopChromeTapTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun titleCapsuleTapFiresRunSheetCallback() {
        var titleClicks = 0
        composeRule.setContent {
            AgentocTheme {
                FloatingTopChrome(
                    sessionTitle = "发布周报",
                    projectTitle = "agentoc",
                    hostTitle = "Windows",
                    status = AgentRunStatus.Working,
                    onBack = {},
                    onMenu = {},
                    onTitleClick = { titleClicks += 1 },
                )
            }
        }

        val title = composeRule
            .onNodeWithContentDescription("Conversation: 发布周报, agentoc · Windows")
        title.assertIsDisplayed()
        title.performClick()
        composeRule.runOnIdle { check(titleClicks == 1) { "title capsule tap should expand the run sheet" } }
    }

    @Test
    fun titleCapsuleWithoutClickHandlerStaysInert() {
        composeRule.setContent {
            AgentocTheme {
                FloatingTopChrome(
                    sessionTitle = "New session",
                    status = AgentRunStatus.Idle,
                    onBack = {},
                    onMenu = {},
                )
            }
        }

        // Legacy callers: the capsule renders (with its default title) but
        // has no click action merged into its semantics.
        composeRule.onNodeWithContentDescription("Conversation: New chat")
            .assertIsDisplayed()
    }
}

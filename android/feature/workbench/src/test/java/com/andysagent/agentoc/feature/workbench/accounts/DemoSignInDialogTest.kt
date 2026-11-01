package com.andysagent.agentoc.feature.workbench.accounts

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import org.junit.Rule
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-w320dp-h568dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DemoSignInDialogTest {
    @get:Rule val rule = createComposeRule()

    @Test fun invalidFormCannotSignInAndExplainsRealWorkspace() {
        var dismisses = 0
        rule.setContent { AgentocTheme { DemoSignInDialog(DemoSignInUiState(open = true), {}, {}, {}, { dismisses++ }) } }
        rule.onNodeWithText("Test account sign-in").assertIsDisplayed()
        rule.onNodeWithText("This demo workspace is shared with other testers. Do not enter personal or sensitive information in chats. Use sample data only.").assertIsDisplayed()
        rule.onNodeWithText("Sign in").assertIsNotEnabled()
        rule.onNodeWithText("Cancel").performClick(); assertEquals(1, dismisses)
    }

    @Test fun busyPreventsDuplicateSubmissionAndDismissal() {
        rule.setContent { AgentocTheme { DemoSignInDialog(DemoSignInUiState(open = true, busy = true), {}, {}, {}, {}) } }
        rule.onNodeWithText("Sign in").assertIsNotEnabled()
        rule.onNodeWithText("Cancel").assertIsNotEnabled()
    }

    @Test fun failedLoginHasActionableSafeText() {
        rule.setContent { AgentocTheme { DemoSignInDialog(DemoSignInUiState(open = true, error = DemoSignInError.Credentials), {}, {}, {}, {}) } }
        rule.onNodeWithText("Check the demo username and password, then try again.").assertIsDisplayed()
    }
}

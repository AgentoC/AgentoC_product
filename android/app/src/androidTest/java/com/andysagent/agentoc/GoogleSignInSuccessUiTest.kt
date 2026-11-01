package com.andysagent.agentoc

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.feature.workbench.GoogleSignInSuccessAction
import com.andysagent.agentoc.feature.workbench.GoogleSignInSuccessScreen
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class GoogleSignInSuccessUiTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun connectActionIsShownAfterPairingSignIn() {
        var action: GoogleSignInSuccessAction? = null
        composeRule.setContent {
            AgentocTheme {
                GoogleSignInSuccessScreen(
                    action = GoogleSignInSuccessAction.ConnectComputer,
                    onAction = { action = it },
                )
            }
        }

        composeRule.onNodeWithContentDescription("Signed in successfully").assertIsDisplayed()
        composeRule.onNodeWithText("Signed in").assertIsDisplayed()
        composeRule.onNodeWithText("Connect a computer").performClick()
        composeRule.runOnIdle { assertEquals(GoogleSignInSuccessAction.ConnectComputer, action) }
    }

    @Test
    fun enterAppActionIsShownAfterAccountSignIn() {
        var action: GoogleSignInSuccessAction? = null
        composeRule.setContent {
            AgentocTheme {
                GoogleSignInSuccessScreen(
                    action = GoogleSignInSuccessAction.EnterApp,
                    onAction = { action = it },
                )
            }
        }

        composeRule.onNodeWithText("Enter app").performClick()
        composeRule.runOnIdle { assertEquals(GoogleSignInSuccessAction.EnterApp, action) }
    }

    @Test
    fun welcomeSignInActionReturnsToSignedInWelcome() {
        var action: GoogleSignInSuccessAction? = null
        composeRule.setContent {
            AgentocTheme {
                GoogleSignInSuccessScreen(
                    action = GoogleSignInSuccessAction.OpenSignedInWelcome,
                    onAction = { action = it },
                )
            }
        }

        composeRule.onNodeWithText("Continue").assertDoesNotExist()
        composeRule.onNodeWithText("Continue to connect a computer").performClick()
        composeRule.runOnIdle { assertEquals(GoogleSignInSuccessAction.OpenSignedInWelcome, action) }
    }
}

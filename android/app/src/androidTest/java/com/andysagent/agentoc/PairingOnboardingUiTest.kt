package com.andysagent.agentoc

import androidx.activity.ComponentActivity
import android.content.res.Configuration
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.feature.workbench.PairingOnboardingEvent
import com.andysagent.agentoc.feature.workbench.PairingOnboardingStep
import com.andysagent.agentoc.feature.workbench.PairingOnboardingMode
import com.andysagent.agentoc.feature.workbench.PairingOnboardingUiState
import com.andysagent.agentoc.feature.workbench.WorkbenchScreen
import com.andysagent.agentoc.feature.workbench.WorkbenchUiState
import com.andysagent.agentoc.feature.workbench.R as WorkbenchR
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.util.Locale

class PairingOnboardingUiTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private fun workbenchText(resId: Int): String =
        InstrumentationRegistry.getInstrumentation().targetContext.getString(resId)

    private fun contextForLanguage(languageTag: String) =
        InstrumentationRegistry.getInstrumentation().targetContext.let { base ->
            base.createConfigurationContext(Configuration(base.resources.configuration).apply {
                setLocale(Locale.forLanguageTag(languageTag))
            })
        }

    @Test
    fun firstRunShowsTaskFocusedConnectionEntry() {
        var continued = false
        val title = workbenchText(WorkbenchR.string.welcome_connect_title)
        val scan = workbenchText(WorkbenchR.string.welcome_scan_pairing_code)
        val signIn = workbenchText(WorkbenchR.string.settings_sign_in)
        composeRule.setContent {
            AgentocTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    pairingOnboardingState = PairingOnboardingUiState(
                        open = true,
                        step = PairingOnboardingStep.Welcome,
                    ),
                    onPairingOnboardingEvent = {
                        continued = it == PairingOnboardingEvent.ContinueFromWelcome
                    },
                )
            }
        }

        composeRule.onNodeWithText(title).assertIsDisplayed()
        composeRule.onNodeWithText(scan).assertIsDisplayed()
        composeRule.onNodeWithText(signIn).assertIsDisplayed()
        composeRule.onNodeWithText("Your agents.\nWithin reach.").assertDoesNotExist()
        composeRule.onNodeWithText(signIn).performClick()
        assertTrue("The primary action should continue to pairing", continued)
    }

    @Test
    fun unauthenticatedWelcomeUsesTheReturnToSignedInWelcomeFlow() {
        var request: com.andysagent.agentoc.feature.workbench.GoogleSignInRequest? = null
        val continueWithGoogle = workbenchText(WorkbenchR.string.sign_in_guide_continue_with_google)
        composeRule.setContent {
            AgentocTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    pairingOnboardingState = PairingOnboardingUiState(
                        open = true,
                        step = PairingOnboardingStep.GoogleRequired,
                        mode = PairingOnboardingMode.ConnectComputerFromWelcome,
                    ),
                    onRequestGoogleSignIn = { request = it },
                )
            }
        }

        composeRule.onNodeWithText(continueWithGoogle).performClick()
        composeRule.runOnIdle {
            assertTrue(
                "The unauthenticated Welcome flow should preserve its return route",
                request == com.andysagent.agentoc.feature.workbench.GoogleSignInRequest.PairComputerFromWelcome,
            )
        }
    }

    @Test
    fun welcomeLoginSuccessMapsToSignedInWelcomeAction() {
        var action: com.andysagent.agentoc.feature.workbench.GoogleSignInSuccessAction? = null
        composeRule.setContent {
            AgentocTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    googleSignInSuccess = com.andysagent.agentoc.feature.workbench.GoogleSignInRequest.PairComputerFromWelcome,
                    onGoogleSignInSuccessAction = { action = it },
                )
            }
        }

        composeRule.onNodeWithText("Continue to connect a computer").performClick()
        composeRule.runOnIdle {
            assertTrue(
                "Welcome login success should continue to the signed-in Welcome",
                action == com.andysagent.agentoc.feature.workbench.GoogleSignInSuccessAction.OpenSignedInWelcome,
            )
        }
    }

    @Test
    fun signedInWithoutComputerDefaultsToAccountWelcomeAtLaunch() {
        var learnMethods = false
        var skipped = false
        val scanPairingCode = workbenchText(WorkbenchR.string.welcome_scan_pairing_code)
        val otherMethods = workbenchText(WorkbenchR.string.welcome_other_connection_methods)
        val notNow = workbenchText(WorkbenchR.string.welcome_not_now)
        val signIn = workbenchText(WorkbenchR.string.settings_sign_in)
        composeRule.setContent {
            AgentocTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    // This mirrors a cold launch: the onboarding controller is
                    // idle, the account identity has resolved, and no computer
                    // has been linked yet.
                    showWelcomeAtLaunch = true,
                    welcomeSignedIn = true,
                    onPairingOnboardingEvent = {
                        learnMethods = it == PairingOnboardingEvent.LearnConnectionMethods
                    },
                    onScanPairing = {},
                    onSkipWelcome = { skipped = true },
                )
            }
        }

        composeRule.onNodeWithText(scanPairingCode).assertIsDisplayed()
        composeRule.onNodeWithText(otherMethods).performClick()
        assertTrue("The alternate connection explainer should be reachable", learnMethods)
        composeRule.onNodeWithText(notNow).performClick()
        assertTrue("A signed-in user can enter Home without pairing", skipped)
        composeRule.onNodeWithText(signIn).assertDoesNotExist()
    }

    @Test
    fun connectionMethodsOffersDirectAndTemporaryActions() {
        val events = mutableListOf<PairingOnboardingEvent>()
        var scanTemporary = false
        val directConnection = workbenchText(WorkbenchR.string.welcome_try_direct_connection)
        val temporaryScan = workbenchText(WorkbenchR.string.temporary_pairing_scan)
        composeRule.setContent {
            AgentocTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    pairingOnboardingState = PairingOnboardingUiState(
                        open = true,
                        step = PairingOnboardingStep.ConnectionMethods,
                        mode = PairingOnboardingMode.ConnectComputer,
                    ),
                    onPairingOnboardingEvent = events::add,
                    onScanPairingFromWelcome = { scanTemporary = true },
                )
            }
        }

        composeRule.onNodeWithText(directConnection).assertIsDisplayed().performClick()
        assertTrue(events.contains(PairingOnboardingEvent.StartComputerConnection))
        composeRule.onNodeWithText(temporaryScan).assertIsDisplayed().performClick()
        assertTrue(scanTemporary)
    }

    @Test
    fun welcomeCopyResolvesForEverySupportedLanguage() {
        val expectedTitles = mapOf(
            "en" to "Connect your work computer",
            "zh-CN" to "连接工作设备",
            "zh-TW" to "連接工作裝置",
            "ja" to "仕事用コンピュータに接続",
            "ko" to "업무용 컴퓨터 연결",
            "fr" to "Connecter votre ordinateur de travail",
            "es" to "Conecta tu equipo de trabajo",
        )
        val requiredResources = listOf(
            WorkbenchR.string.welcome_scan_pairing_code,
            WorkbenchR.string.welcome_try_direct_connection,
            WorkbenchR.string.pairing_account_claim_guidance,
            WorkbenchR.string.settings_sign_in,
            WorkbenchR.string.welcome_other_connection_methods,
            WorkbenchR.string.sign_in_guide_title,
            WorkbenchR.string.sign_in_guide_continue_with_google,
            WorkbenchR.string.sign_in_guide_google_account,
        )

        expectedTitles.forEach { (languageTag, expectedTitle) ->
            val context = contextForLanguage(languageTag)
            assertEquals(
                "Welcome title should resolve for $languageTag",
                expectedTitle,
                context.getString(WorkbenchR.string.welcome_connect_title),
            )
            assertTrue(
                "Welcome copy should resolve for $languageTag",
                requiredResources.all { context.getString(it).isNotBlank() },
            )
        }
    }

    @Test
    fun googleSignInGuideUsesAFullScreenStepWithBackAndPrimaryAction() {
        var requestedSignIn = false
        var returnedToWelcome = false
        val title = workbenchText(WorkbenchR.string.sign_in_guide_title)
        val continueWithGoogle = workbenchText(WorkbenchR.string.sign_in_guide_continue_with_google)
        val backToWelcome = workbenchText(WorkbenchR.string.welcome_back_to_connection)
        composeRule.setContent {
            AgentocTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    pairingOnboardingState = PairingOnboardingUiState(
                        open = true,
                        step = PairingOnboardingStep.GoogleRequired,
                    ),
                    onPairingOnboardingEvent = {
                        returnedToWelcome = it == PairingOnboardingEvent.BackToWelcome
                    },
                    onRequestGoogleSignIn = { requestedSignIn = true },
                )
            }
        }

        composeRule.onNodeWithText(title).assertIsDisplayed()
        composeRule.onNodeWithText(continueWithGoogle).performClick()
        assertTrue("The primary action should request the sign-in confirmation", requestedSignIn)
        composeRule.onNodeWithContentDescription(backToWelcome).performClick()
        assertTrue("The back action should return to welcome", returnedToWelcome)
    }

    @Test
    fun signInModeUsesAccountGoogleRequest() {
        var request: com.andysagent.agentoc.feature.workbench.GoogleSignInRequest? = null
        val continueWithGoogle = workbenchText(WorkbenchR.string.sign_in_guide_continue_with_google)
        composeRule.setContent {
            AgentocTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    pairingOnboardingState = PairingOnboardingUiState(
                        open = true,
                        step = PairingOnboardingStep.GoogleRequired,
                        mode = PairingOnboardingMode.SignIn,
                    ),
                    onRequestGoogleSignIn = { request = it },
                )
            }
        }

        composeRule.onNodeWithText(continueWithGoogle).performClick()
        composeRule.runOnIdle {
            assertTrue(
                "The sign-in entry point should request account authentication",
                request == com.andysagent.agentoc.feature.workbench.GoogleSignInRequest.Account,
            )
        }
    }

    @Test
    fun scanStepShowsQrActionAndDoesNotAskForEndpoint() {
        var scanned = false
        val linkComputer = workbenchText(WorkbenchR.string.pairing_link_computer)
        val guidance = workbenchText(WorkbenchR.string.pairing_account_claim_guidance)
        composeRule.setContent {
            AgentocTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    pairingOnboardingState = PairingOnboardingUiState(
                        open = true,
                        step = PairingOnboardingStep.AccountClaimRequired,
                    ),
                    onPairingOnboardingEvent = {},
                    onScanPairing = { scanned = true },
                )
            }
        }

        composeRule.onNodeWithText(guidance).assertIsDisplayed()
        composeRule.onNodeWithText(linkComputer).performClick()
        assertTrue("The scan action should open the device scanner", scanned)
        composeRule.onNodeWithText("Pairing URI").assertDoesNotExist()
    }

    @Test
    fun errorStepShowsRecoveryMessage() {
        val retry = workbenchText(WorkbenchR.string.pairing_try_again)
        composeRule.setContent {
            AgentocTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    pairingOnboardingState = PairingOnboardingUiState(
                        open = true,
                        step = PairingOnboardingStep.Error,
                        errorMessage = "That QR code has expired.",
                    ),
                )
            }
        }

        composeRule.waitForIdle()
        composeRule.onNodeWithText("That QR code has expired.").assertIsDisplayed()
        composeRule.onNodeWithText(retry).assertIsDisplayed()
    }

    @Test
    fun scannerFailureFromWelcomeKeepsABackToConnectionAction() {
        var returnedToWelcome = false
        val back = workbenchText(WorkbenchR.string.pairing_back)
        val scannerUnavailable = workbenchText(WorkbenchR.string.pairing_scanner_title)
        val welcomeTitle = workbenchText(WorkbenchR.string.welcome_connect_title)
        composeRule.setContent {
            AgentocTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    pairingOnboardingState = PairingOnboardingUiState(
                        open = true,
                        step = PairingOnboardingStep.Error,
                        scannerFailureReturnsToWelcome = true,
                        scannerUnavailable = true,
                    ),
                    onPairingOnboardingEvent = {
                        returnedToWelcome = it == PairingOnboardingEvent.BackToWelcome
                    },
                    onScanPairingFromWelcome = {},
                )
            }
        }

        composeRule.onNodeWithText(scannerUnavailable).assertIsDisplayed()
        composeRule.onNodeWithText(welcomeTitle).assertIsDisplayed()
        composeRule.onNodeWithText(back).assertIsDisplayed().performClick()
        assertTrue("Scanner errors from Welcome should return to the connection entry", returnedToWelcome)
    }

    @Test
    fun quotaErrorExplainsLimitAndOpensSubscriptionInfo() {
        var opened = false
        val quotaHint = workbenchText(WorkbenchR.string.pairing_error_quota_hint)
        val viewPlans = workbenchText(WorkbenchR.string.pairing_view_pro_plans)
        composeRule.setContent {
            AgentocTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    pairingOnboardingState = PairingOnboardingUiState(
                        open = true,
                        step = PairingOnboardingStep.Error,
                        errorMessage = "This Google account has reached the Free plan limit of 1 phone. Upgrade to Pro to link more devices.",
                        subscriptionRequired = true,
                    ),
                    onOpenSubscription = { opened = true },
                )
            }
        }

        composeRule.onNodeWithText("This Google account has reached the Free plan limit of 1 phone. Upgrade to Pro to link more devices.")
            .assertIsDisplayed()
        composeRule.onNodeWithText(quotaHint).assertIsDisplayed()
        composeRule.onNodeWithText(viewPlans).performClick()
        assertTrue("The subscription action should open the introduction page", opened)
    }

    @Test
    fun subscriptionActionRendersTheProIntroductionPage() {
        var back = false
        composeRule.setContent {
            AgentocTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    subscriptionInfoOpen = true,
                    onCloseSubscriptionInfo = { back = true },
                )
            }
        }

        composeRule.onNodeWithText("Upgrade to Pro").assertIsDisplayed()
        composeRule.onNodeWithText("Connect more phones and computers to the same AgentoC account. Pro is coming soon.")
            .assertIsDisplayed()
        composeRule.onNodeWithText("Subscription and payment are not available yet.").assertIsDisplayed()
        composeRule.onNodeWithText("Back to connection").performClick()
        assertTrue("The introduction page should support returning to the connection flow", back)
    }
}

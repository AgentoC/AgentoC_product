package com.andysagent.agentoc

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.andysagent.agentoc.core.appapi.*
import com.andysagent.agentoc.core.datastore.ComputerDirectory
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.feature.appapi.CaptureScreen
import com.andysagent.agentoc.feature.appapi.CaptureUiState
import org.junit.Rule
import org.junit.Test

class SmartIntakeUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun clarificationIsVisibleWithoutProjectPicker() {
        val draft = CaptureDraft("draft", "owner", 0, input = CaptureInput("Reference"),
            instruction = "Help with this", targetInstanceId = "pc-fixed", intakeId = "intake-draft",
            intakeDecision = IntakeDecision(1, "intake-draft", "decision", "a".repeat(64),
                "pc-fixed", "needs_clarification", question = "Is this a new product?",
                contextComplete = true, requiresClarification = true))
        compose.setContent { AgentocTheme {
            CaptureScreen(CaptureUiState(loading = false, draft = draft, directory = ComputerDirectory()), {})
        } }
        compose.onNodeWithText("Is this a new product?").assertIsDisplayed()
    }
}

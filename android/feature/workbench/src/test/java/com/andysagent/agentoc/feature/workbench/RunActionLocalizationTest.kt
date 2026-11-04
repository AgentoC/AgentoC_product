package com.andysagent.agentoc.feature.workbench

import androidx.compose.material3.Text
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.timeline.RunActionUiState
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "zh-rCN-w320dp-h720dp")
class RunActionLocalizationTest {
    @get:Rule val rule = createComposeRule()

    @Test fun generatedTemplateIsLocalizedAndProviderProseIsPreserved() {
        val generated = RunActionUiState("read", "Reading README.md", presentationVerb = "read", presentationSubject = "README.md")
        val provider = RunActionUiState("execute", "Checking how reconnect restores the clock")
        rule.setContent { AgentocTheme { androidx.compose.foundation.layout.Column {
            Text(presentRunAction(generated))
            Text(presentRunAction(provider))
        } } }
        rule.onNodeWithText("正在读取 README.md").assertIsDisplayed()
        rule.onNodeWithText(provider.sentence).assertIsDisplayed()
    }
}

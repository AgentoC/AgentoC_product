package com.andysagent.agentoc.feature.workbench

import androidx.compose.material3.Text
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.timeline.RunActionUiState
import com.andysagent.agentoc.core.timeline.RunActionFormatter
import com.andysagent.agentoc.core.timeline.TimelineItem
import com.andysagent.agentoc.core.timeline.TimelineOperationKind
import com.andysagent.agentoc.core.timeline.TimelineOperationStatus
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
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

    @Test fun genericServerAndHistoricalLabelsAreLocalized() {
        val running = RunActionFormatter.fromServer(Json.parseToJsonElement(
            """{"state":"working","kind":"execute","labelKind":"execute","subject":"execute","detail":"Bash"}""",
        ) as JsonObject)!!
        val finished = RunActionFormatter.forOperation(TimelineItem.Operation(
            "op", 1, TimelineOperationKind.Command, "Running command", "Bash", TimelineOperationStatus.Completed,
        ))
        rule.setContent { AgentocTheme { androidx.compose.foundation.layout.Column {
            Text(presentRunAction(running))
            Text(presentCompletedAction(finished))
        } } }
        rule.onNodeWithText("正在运行 命令").assertIsDisplayed()
        rule.onNodeWithText("运行了 命令").assertIsDisplayed()
    }
}

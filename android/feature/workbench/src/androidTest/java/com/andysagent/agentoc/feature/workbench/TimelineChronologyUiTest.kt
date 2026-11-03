package com.andysagent.agentoc.feature.workbench

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.timeline.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class TimelineChronologyUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun claudeFileActivityDisplaysItsFilename() {
        val op = TimelineItem.Operation("write", 2, TimelineOperationKind.Tool, "Write", "", TimelineOperationStatus.InProgress,
            toolName = "Write", inputJson = """{"file_path":"/work/internet-and-web.md"}""")
        val action = RunActionFormatter.forRun(RunActionFormatter.RunActionStatus.Working, null, listOf(op))
        rule.setContent { AgentocTheme { ActiveRunActionBar(com.andysagent.agentoc.core.agentui.AgentRunStatus.Working, action?.sentence) } }
        rule.onNodeWithText("Editing internet-and-web.md").assertIsDisplayed()
    }

    @Test fun thinkingExpandsAndToolRecordsStayHidden() {
        val items = listOf(
            TimelineItem.Message("u", 1, TimelineRole.User, "Inspect the file", true),
            TimelineItem.Message("a", 2, TimelineRole.Agent, "First explanation", true),
            TimelineItem.Operation("op", 3, TimelineOperationKind.Command, "Check source", "done", TimelineOperationStatus.Completed),
            TimelineItem.Operation("thought", 3, TimelineOperationKind.Tool, "Thinking", "Private reasoning detail", TimelineOperationStatus.Completed, isReasoning = true),
            TimelineItem.Message("b", 4, TimelineRole.Agent, "Final conclusion", true),
        )
        val turn = TurnGroupProjector().project(items).single()
        rule.setContent { AgentocTheme { Column {
            TurnTimelineView(turn, true, null, null, {}, { _, _ -> }, {}, {})
        } } }
        val first = rule.onNodeWithText("First explanation").getUnclippedBoundsInRoot().top
        rule.onNodeWithText("Check source", substring = true).assertDoesNotExist()
        rule.onNodeWithText("Private reasoning detail").assertDoesNotExist()
        val thinking = rule.onNodeWithTag("thinking-row").getUnclippedBoundsInRoot().top
        val last = rule.onNodeWithText("Final conclusion").getUnclippedBoundsInRoot().top
        assertTrue("Thinking moved ahead of commentary", first < thinking)
        assertTrue("The final answer moved ahead of thinking", thinking < last)
        rule.onNodeWithContentDescription(rule.activity.getString(R.string.timeline_details_show)).performClick()
        rule.onNodeWithText("Private reasoning detail").assertIsDisplayed()
    }
}

package com.andysagent.agentoc.feature.workbench

import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.model.Approval
import com.andysagent.agentoc.core.model.ApprovalOption
import com.andysagent.agentoc.core.model.ApprovalQuestion
import com.andysagent.agentoc.core.model.AttentionReducer
import com.andysagent.agentoc.core.model.AttentionUiState
import com.andysagent.agentoc.core.model.Session
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ApprovalAttentionDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun ordinaryApprovalOffersBothDecisions() {
        val approval = Approval(id = "a", sessionId = "s", runId = "r", title = "Run command", command = "echo test")
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval)))
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { AgentocTheme { AttentionSurface(state, events::add, onOpenSession = {}) } }
        val approve = rule.activity.getString(R.string.attention_approve)
        val deny = rule.activity.getString(R.string.attention_deny)
        rule.onNodeWithText(approve).assertIsDisplayed().performClick()
        rule.onNodeWithText(deny).assertIsDisplayed().performClick()
        rule.runOnIdle {
            val id = requireNotNull(state.activeItemId)
            assertEquals(listOf(AttentionEvent.ResolveApproval(id, true), AttentionEvent.ResolveApproval(id, false)), events)
        }
    }

    @Test fun firstQuestionOptionExpandsBeforeItAnswers() {
        val approval = Approval(id = "q", sessionId = "s", runId = "r", title = "Choose",
            questions = listOf(ApprovalQuestion(question = "Choose a release", options = listOf(ApprovalOption("Canary"), ApprovalOption("Full")))))
        var state by mutableStateOf(AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval))))
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { AgentocTheme { AttentionSurface(state, onEvent = { event ->
            events.add(event)
            if (event is AttentionEvent.SetExpanded) state = state.copy(expanded = event.expanded)
        }, onOpenSession = {}) } }
        rule.onNodeWithText("Canary").assertIsDisplayed().performClick()
        rule.waitForIdle()
        rule.runOnIdle { assertEquals(listOf(AttentionEvent.SetExpanded(requireNotNull(state.activeItemId), true)), events) }
        rule.onNodeWithText("Canary").performClick()
        rule.runOnIdle { assertEquals(AttentionEvent.ResolveQuestion(requireNotNull(state.activeItemId), 0, 0), events.last()) }
    }
}

package com.andysagent.agentoc.feature.workbench

import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
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
        val approval = Approval(id = "a", sessionId = "s", runId = "r", title = "Run command", command = "echo test",
            permissionsJson = """{"network":{"enabled":true}}""")
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval))).copy(expanded = true)
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { AgentocTheme { AttentionSurface(state, events::add, onOpenSession = {}) } }
        val approve = rule.activity.getString(R.string.attention_approve)
        val deny = rule.activity.getString(R.string.attention_deny)
        rule.onNodeWithText(rule.activity.getString(R.string.attention_command, "echo test")).assertIsDisplayed()
        rule.onNodeWithText(rule.activity.getString(R.string.approval_scope_network)).assertIsDisplayed()
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

    @Test fun multipleQuestionsAcceptDistinctCustomAnswers() {
        val approval = Approval(id = "multi", sessionId = "s", runId = "r", title = "Questions",
            questions = listOf(ApprovalQuestion(question = "First question"), ApprovalQuestion(question = "Second question")))
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval))).copy(expanded = true)
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { AgentocTheme { AttentionSurface(state, events::add, onOpenSession = {}) } }
        rule.onNode(hasSetTextAction() and hasAnyAncestor(hasContentDescription("问题 1 的自定义回复")), useUnmergedTree = true).performTextInput("alpha")
        rule.onNode(hasSetTextAction() and hasAnyAncestor(hasContentDescription("问题 2 的自定义回复")), useUnmergedTree = true).performTextInput("beta")
        rule.onNodeWithText("发送").performClick()
        rule.runOnIdle {
            val answer = events.filterIsInstance<AttentionEvent.ResolveQuestions>().single()
            assertEquals(listOf(-1, -1), answer.choices)
            assertEquals(listOf("alpha", "beta"), answer.customAnswers)
        }
    }

    @Test fun closingNoticeDoesNotMakeAnApprovalDecision() {
        val approval = Approval(id = "a", sessionId = "s", runId = "r", title = "Run command")
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval)))
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { AgentocTheme { AttentionSurface(state, events::add, onOpenSession = {}) } }
        rule.onNodeWithContentDescription(rule.activity.getString(R.string.approval_notice_close)).performClick()
        rule.runOnIdle { assertEquals(listOf(AttentionEvent.Dismiss(requireNotNull(state.activeItemId))), events) }
    }

    @Test fun untouchedNoticeAutomaticallyDismisses() {
        val approval = Approval(id = "a", sessionId = "s", runId = "r", title = "Run command")
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval)))
        val events = mutableListOf<AttentionEvent>()
        rule.mainClock.autoAdvance = false
        rule.setContent { AgentocTheme { AttentionSurface(state, events::add, onOpenSession = {}) } }
        rule.mainClock.advanceTimeBy(12_500)
        rule.runOnIdle { assertEquals(listOf(AttentionEvent.Dismiss(requireNotNull(state.activeItemId))), events) }
        rule.mainClock.autoAdvance = true
    }
}

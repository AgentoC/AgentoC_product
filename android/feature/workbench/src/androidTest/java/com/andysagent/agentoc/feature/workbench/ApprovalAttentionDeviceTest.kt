package com.andysagent.agentoc.feature.workbench

import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.model.Approval
import com.andysagent.agentoc.core.model.ApprovalAction
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

    @Test fun conversationShowsAndSubmitsAllQuestionAnswers() {
        var state by mutableStateOf(DecisionQuestionUiState(id = "q", question = "First", options = emptyList(),
            questionGroups = listOf(ApprovalQuestion(question = "First"), ApprovalQuestion(question = "Second"))))
        var submitted: Map<Int, String>? = null
        rule.setContent { AgentocTheme { DecisionQuestionCard(
            state = state, onOptionSelected = {}, onWriteInChanged = {}, onSubmit = { submitted = state.customByQuestion },
            onMultiWriteInChanged = { index, text -> state = state.copy(customByQuestion = state.customByQuestion + (index to text)) },
        ) } }
        rule.onNodeWithTag("decision-0-write-in").performTextInput("alpha")
        rule.onNodeWithTag("decision-1-write-in").performTextInput("beta")
        rule.onNodeWithTag("decision-submit").performClick()
        rule.runOnIdle { assertEquals(mapOf(0 to "alpha", 1 to "beta"), submitted) }
    }

    @Test fun privilegedCategoriesKeepDeleteOptInAndUseSeparateActions() {
        val approval = Approval(id = "b", sessionId = "s", runId = "r", batchId = "b", title = "Batch",
            kind = "privileged_batch_request", passkeyRequired = true, actions = listOf(
                ApprovalAction(id = "o", description = "Restart", category = "privileged_other"),
                ApprovalAction(id = "d", description = "Delete", category = "destructive_delete"),
            ))
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval))).copy(expanded = true)
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { AgentocTheme { AttentionSurface(state, events::add, onOpenSession = {}) } }
        val approve = rule.onAllNodesWithText(rule.activity.getString(R.string.attention_approve_selected))
        approve[0].assertIsEnabled().performClick()
        approve[1].assertIsNotEnabled()
        val deny = rule.onAllNodesWithText(rule.activity.getString(R.string.attention_deny))
        deny[1].performClick()
        rule.runOnIdle {
            val id = requireNotNull(state.activeItemId)
            assertEquals(listOf(AttentionEvent.ResolvePrivilegedCategory(id, "privileged_other", setOf("o")),
                AttentionEvent.ResolvePrivilegedCategory(id, "destructive_delete", emptySet())), events)
        }
    }
}

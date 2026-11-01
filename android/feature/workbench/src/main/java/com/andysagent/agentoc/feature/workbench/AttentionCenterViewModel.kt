package com.andysagent.agentoc.feature.workbench

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.andysagent.agentoc.core.domain.ApprovalResolutionCoordinator
import com.andysagent.agentoc.core.domain.SessionRepository
import com.andysagent.agentoc.core.model.Approval
import com.andysagent.agentoc.core.model.AttentionReducer
import com.andysagent.agentoc.core.model.AttentionUiState
import com.andysagent.agentoc.core.model.ApprovalActionDecision
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

sealed interface AttentionEvent {
    /** The Session currently open on screen; its items never surface globally. */
    data class SetVisibleSession(val sessionId: String?) : AttentionEvent
    data class SetExpanded(val itemId: String, val expanded: Boolean) : AttentionEvent
    /** Closes the current presentation only; server-side facts stay untouched. */
    data class Dismiss(val itemId: String) : AttentionEvent
    data class ResolveApproval(val itemId: String, val approve: Boolean) : AttentionEvent
    data class ResolveActionBatch(
        val itemId: String,
        val selectedActionIds: Set<String>,
        val approvalIntent: String = "approve",
    ) : AttentionEvent

    /**
     * Answers an ask-user approval from the overlay: tapping [optionIndex] of
     * question [questionIndex], or submitting the typed [customAnswer]. Every
     * answer still re-validates against the server projection before it is
     * submitted.
     */
    data class ResolveQuestion(
        val itemId: String,
        val questionIndex: Int,
        val optionIndex: Int?,
        val customAnswer: String = "",
    ) : AttentionEvent

    /** Submits one answer slot per question after a multi-question prompt is complete. */
    data class ResolveQuestions(
        val itemId: String,
        val choices: List<Int>,
        val customAnswer: String = "",
    ) : AttentionEvent
    data object ClearError : AttentionEvent
}

/**
 * Single source of truth for the global attention surface. It only projects
 * Room/server facts into a display queue: approvals stay owned by the
 * repository, and dismissal never mutates server state.
 */
class AttentionCenterViewModel(
    private val repository: SessionRepository,
    private val brokerApprovalController: BrokerApprovalController? = null,
) : ViewModel() {

    private val coordinator = ApprovalResolutionCoordinator(repository)
    private val mutableState = MutableStateFlow(AttentionUiState())
    val state: StateFlow<AttentionUiState> = mutableState.asStateFlow()

    private val visibleSessionId = MutableStateFlow<String?>(null)
    private val brokerApprovals = MutableStateFlow<List<Approval>>(emptyList())

    init {
        viewModelScope.launch {
            combine(
                repository.observeSessions(),
                repository.observeAllPendingApprovals(),
                visibleSessionId,
                brokerApprovals,
            ) { sessions, approvals, visible, broker ->
                (AttentionReducer.project(sessions, approvals) + AttentionReducer.projectBrokerApprovals(broker)) to visible
            }.collect { (items, visible) ->
                mutableState.update { current ->
                    AttentionReducer.reduce(current.copy(visibleSessionId = visible), items)
                }
            }
        }
        brokerApprovalController?.let { controller ->
            viewModelScope.launch {
                controller.observePendingApprovals().collect { brokerApprovals.value = it }
            }
        }
    }

    fun onEvent(event: AttentionEvent) {
        when (event) {
            is AttentionEvent.SetVisibleSession -> {
                if (visibleSessionId.value != event.sessionId) visibleSessionId.value = event.sessionId
            }
            is AttentionEvent.SetExpanded -> mutableState.update { current ->
                if (current.activeItemId != event.itemId) current
                else current.copy(expanded = event.expanded)
            }
            is AttentionEvent.Dismiss -> mutableState.update { current ->
                val remaining = current.items.filterNot { it.id == event.itemId }
                current.copy(
                    dismissedItemIds = current.dismissedItemIds + event.itemId,
                    items = remaining,
                    activeItemId = remaining.firstOrNull()?.id,
                    expanded = false,
                )
            }
            is AttentionEvent.ResolveApproval -> resolveApproval(event.itemId, event.approve)
            is AttentionEvent.ResolveActionBatch -> resolveActionBatch(event)
            is AttentionEvent.ResolveQuestion -> resolveQuestion(event)
            is AttentionEvent.ResolveQuestions -> resolveQuestions(event)
            AttentionEvent.ClearError -> mutableState.update { it.copy(error = null) }
        }
    }

    private fun resolveApproval(itemId: String, approve: Boolean) {
        val current = mutableState.value
        if (current.resolvingItemId != null) return
        val item = current.items.firstOrNull { it.id == itemId } ?: return
        val approval = item.approval ?: return
        if (approval.brokerDecisionUncertain) return
        if (approval.kind == AttentionReducer.WINDOWS_BROKER_APPROVAL_KIND) {
            val controller = brokerApprovalController ?: return
            mutableState.update { it.copy(resolvingItemId = itemId, error = null) }
            viewModelScope.launch {
                val outcome = try {
                    controller.resolve(approval, approve)
                    ApprovalResolutionCoordinator.Outcome.Submitted
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (unknown: BrokerApprovalOutcomeUnknownException) {
                    markBrokerUnknown(itemId, approval, unknown.message ?: "Broker decision outcome unknown")
                    ApprovalResolutionCoordinator.Outcome.Failed(unknown.message ?: "Broker decision outcome unknown")
                } catch (error: Throwable) {
                    ApprovalResolutionCoordinator.Outcome.Failed(error.message ?: "Windows Broker approval failed")
                }
                consumeResolution(itemId, outcome)
                if (outcome is ApprovalResolutionCoordinator.Outcome.Submitted) {
                    brokerApprovals.value = brokerApprovals.value.filterNot {
                        it.id == approval.id && it.brokerTargetInstanceId == approval.brokerTargetInstanceId &&
                            it.brokerChallengeDigest == approval.brokerChallengeDigest
                    }
                }
            }
            return
        }
        mutableState.update { it.copy(resolvingItemId = itemId, error = null) }
        viewModelScope.launch {
            val outcome = coordinator.resolvePlainApproval(item.sessionId, approval.id, approve)
            consumeResolution(itemId, outcome)
        }
    }

    private fun resolveActionBatch(event: AttentionEvent.ResolveActionBatch) {
        val current = mutableState.value
        if (current.resolvingItemId != null) return
        val item = current.items.firstOrNull { it.id == event.itemId } ?: return
        val approval = item.approval ?: return
        val runId = approval.runId ?: return
        val batchId = approval.batchId ?: return
        if (approval.actions.isEmpty() || approval.actions.any { it.needsPasskey }) return
        val selected = event.selectedActionIds
        val decisions = approval.actions.map { action ->
            ApprovalActionDecision(action.id, if (action.id in selected) "approve" else "deny")
        }
        mutableState.update { it.copy(resolvingItemId = event.itemId, error = null) }
        viewModelScope.launch {
            val outcome = try {
                repository.resolveApprovedActionBatch(
                    sessionId = item.sessionId,
                    runId = runId,
                    batchId = batchId,
                    decisions = decisions,
                    approvalIntent = event.approvalIntent,
                )
                ApprovalResolutionCoordinator.Outcome.Submitted
            } catch (error: Throwable) {
                ApprovalResolutionCoordinator.Outcome.Failed(error.message ?: "审批提交失败")
            }
            consumeResolution(event.itemId, outcome)
        }
    }

    private fun resolveQuestion(event: AttentionEvent.ResolveQuestion) {
        val current = mutableState.value
        if (current.resolvingItemId != null) return
        val item = current.items.firstOrNull { it.id == event.itemId } ?: return
        val approval = item.approval ?: return
        mutableState.update { it.copy(resolvingItemId = event.itemId, error = null) }
        viewModelScope.launch {
            val outcome = coordinator.resolveQuestionApproval(
                sessionId = item.sessionId,
                approvalId = approval.id,
                questionIndex = event.questionIndex,
                optionIndex = event.optionIndex,
                customAnswer = event.customAnswer,
            )
            consumeResolution(event.itemId, outcome)
        }
    }

    private fun resolveQuestions(event: AttentionEvent.ResolveQuestions) {
        val current = mutableState.value
        if (current.resolvingItemId != null) return
        val item = current.items.firstOrNull { it.id == event.itemId } ?: return
        val approval = item.approval ?: return
        mutableState.update { it.copy(resolvingItemId = event.itemId, error = null) }
        viewModelScope.launch {
            val outcome = coordinator.resolveQuestionsApproval(
                sessionId = item.sessionId,
                approvalId = approval.id,
                choices = event.choices,
                customAnswer = event.customAnswer,
            )
            consumeResolution(event.itemId, outcome)
        }
    }

    private fun consumeResolution(itemId: String, outcome: ApprovalResolutionCoordinator.Outcome) {
        mutableState.update { state ->
            when (outcome) {
                is ApprovalResolutionCoordinator.Outcome.Submitted,
                is ApprovalResolutionCoordinator.Outcome.Stale,
                ->
                    // The next Room projection owns the post-resolution
                    // queue; drop the presentation immediately so the same
                    // approval cannot be submitted twice.
                    state.copy(
                        resolvingItemId = null,
                        dismissedItemIds = state.dismissedItemIds + itemId,
                        items = state.items.filterNot { it.id == itemId },
                        activeItemId = if (state.activeItemId == itemId) state.items.firstOrNull { it.id != itemId }?.id else state.activeItemId,
                        expanded = false,
                    )
                is ApprovalResolutionCoordinator.Outcome.RequiresSession -> state.copy(resolvingItemId = null)
                is ApprovalResolutionCoordinator.Outcome.Failed -> state.copy(
                    resolvingItemId = null,
                    error = outcome.message,
                )
            }
        }
    }

    private fun markBrokerUnknown(itemId: String, approval: Approval, message: String) {
        val uncertain = approval.copy(
            brokerDecisionUncertain = true,
            title = message,
            reason = "$message\n${approval.reason.orEmpty()}",
        )
        brokerApprovals.update { approvals ->
            approvals.map { if (it.id == approval.id && it.brokerChallengeDigest == approval.brokerChallengeDigest &&
                it.brokerTargetInstanceId == approval.brokerTargetInstanceId) uncertain else it }
        }
        mutableState.update { state ->
            state.copy(items = state.items.map { item ->
                if (item.id == itemId) item.copy(title = message, summary = message, reason = uncertain.reason, approval = uncertain)
                else item
            })
        }
    }

}

class AttentionCenterViewModelFactory(
    private val repository: SessionRepository,
    private val brokerApprovalController: BrokerApprovalController? = null,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        AttentionCenterViewModel(repository, brokerApprovalController) as T
}

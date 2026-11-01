package com.andysagent.agentoc.core.domain

import com.andysagent.agentoc.core.model.Approval
import com.andysagent.agentoc.core.model.ApprovalOption
import com.andysagent.agentoc.core.model.ApprovalQuestion

/**
 * Shared plain-approval resolution used by surfaces outside the session
 * timeline. Every submission re-reads the pending approval from the
 * repository first: a stale FCM payload or an expired row must never drive a
 * side effect. Batch and passkey resolutions stay inside their session's
 * structured card, so this coordinator refuses them instead of building a
 * parallel approval protocol.
 */
class ApprovalResolutionCoordinator(private val repository: SessionRepository) {

    sealed interface Outcome {
        /** The re-validated approval was submitted through the plain path. */
        data object Submitted : Outcome

        /** The approval no longer exists or is not pending anymore. */
        data object Stale : Outcome

        /** The item requires the session's structured card (batch/passkey). */
        data object RequiresSession : Outcome

        /** The submission failed; the message is user-presentable. */
        data class Failed(val message: String) : Outcome
    }

    /** Result of the mandatory re-read that gates every submission. */
    private sealed interface PendingRead {
        data class Found(val approval: Approval) : PendingRead
        data object Missing : PendingRead
        data class Error(val message: String) : PendingRead
    }

    /**
     * Re-reads [approvalId], validates that it is still a pending plain
     * approval, and submits [approve] through the repository path the session
     * card itself uses.
     */
    suspend fun resolvePlainApproval(
        sessionId: String,
        approvalId: String,
        approve: Boolean,
        requestId: String = newRequestId(),
    ): Outcome {
        return when (val read = readPending(sessionId, approvalId)) {
            is PendingRead.Error -> Outcome.Failed(read.message)
            is PendingRead.Missing -> Outcome.Stale
            is PendingRead.Found -> {
                val pending = read.approval
                if (pending.status != "pending") return Outcome.Stale
                if (pending.requiresStructuredResolution()) return Outcome.RequiresSession
                val decision = if (approve) "approve" else "deny"
                try {
                    val runId = pending.runId
                    if (runId != null) {
                        repository.resolveRuntimeApproval(
                            runId = runId,
                            approvalId = approvalId,
                            decision = decision,
                            requestId = requestId,
                        )
                    } else {
                        repository.decideConfirmation(
                            sessionId = sessionId,
                            confirmationId = approvalId,
                            decision = decision,
                            requestId = requestId,
                        )
                    }
                    runCatching { repository.refreshSessionDetail(sessionId) }
                    Outcome.Submitted
                } catch (error: Throwable) {
                    Outcome.Failed(error.message ?: "审批提交失败")
                }
            }
        }
    }

    /**
     * Resolves an ask-user approval with an explicit answer: either the tapped
     * [optionIndex] of question [questionIndex], or a typed [customAnswer].
     * The server contract carries per-question selected option indices with
     * -1 for unanswered questions, so the chosen option is positioned and the
     * rest stay explicitly unanswered instead of being dropped. A re-read that
     * shows the target is no longer a pending question fails closed — a tap on
     * the overlay must never submit an unanswerable approval.
     */
    suspend fun resolveQuestionApproval(
        sessionId: String,
        approvalId: String,
        questionIndex: Int,
        optionIndex: Int?,
        customAnswer: String = "",
        requestId: String = newRequestId(),
    ): Outcome {
        return resolveQuestionChoices(
            sessionId = sessionId,
            approvalId = approvalId,
            choices = emptyList(),
            customAnswer = customAnswer,
            singleQuestionIndex = questionIndex,
            singleOptionIndex = optionIndex,
            requestId = requestId,
        )
    }

    /**
     * Resolves every question in one approval response. The list is positional:
     * each entry is an option index, or -1 when that question uses the single
     * shared custom answer. The server applies that custom answer only to an
     * unanswered slot, so this client rejects more than one unanswered slot.
     */
    suspend fun resolveQuestionsApproval(
        sessionId: String,
        approvalId: String,
        choices: List<Int>,
        customAnswer: String = "",
        requestId: String = newRequestId(),
    ): Outcome {
        return resolveQuestionChoices(
            sessionId = sessionId,
            approvalId = approvalId,
            choices = choices,
            customAnswer = customAnswer,
            requestId = requestId,
        )
    }

    private suspend fun resolveQuestionChoices(
        sessionId: String,
        approvalId: String,
        choices: List<Int>,
        customAnswer: String,
        singleQuestionIndex: Int? = null,
        singleOptionIndex: Int? = null,
        requestId: String,
    ): Outcome {
        return when (val read = readPending(sessionId, approvalId)) {
            is PendingRead.Error -> Outcome.Failed(read.message)
            is PendingRead.Missing -> Outcome.Stale
            is PendingRead.Found -> {
                val pending = read.approval
                if (pending.status != "pending") return Outcome.Stale
                if (pending.requiresStructuredResolution() || !pending.isQuestionApproval()) {
                    return Outcome.RequiresSession
                }
                val answer = customAnswer.trim().take(MAX_CUSTOM_ANSWER)
                val questions = pending.resolutionQuestions()
                val questionCount = questions.size.coerceAtLeast(1)
                val normalizedChoices = if (singleQuestionIndex != null) {
                    if (singleQuestionIndex !in 0 until questionCount) return Outcome.Failed("问题序号无效")
                    List(questionCount) { index ->
                        if (index == singleQuestionIndex) singleOptionIndex ?: -1 else -1
                    }
                } else {
                    if (choices.size != questionCount) return Outcome.Failed("问题回答不完整")
                    choices
                }
                normalizedChoices.forEachIndexed { index, choice ->
                    if (choice < -1) return Outcome.Failed("所选选项不存在")
                    val options = questions.getOrNull(index)?.options.orEmpty()
                    if (choice >= options.size) return Outcome.Failed("所选选项不存在")
                }
                val unansweredCount = normalizedChoices.count { it == -1 }
                if (answer.isEmpty() && unansweredCount > 0) {
                    return Outcome.Failed("请回答所有问题")
                }
                if (unansweredCount > 1) {
                    return Outcome.Failed("自定义回复只能回答一个问题")
                }
                val submittedAnswer = answer.takeIf { it.isNotEmpty() && unansweredCount == 1 }
                try {
                    val runId = pending.runId
                    if (runId != null) {
                        repository.resolveRuntimeApproval(
                            runId = runId,
                            approvalId = approvalId,
                            decision = "approve",
                            choices = normalizedChoices.map(Int::toString),
                            customAnswer = submittedAnswer,
                            requestId = requestId,
                        )
                    } else {
                        // Legacy session confirmations carry no question payload;
                        // the resolution still re-validates before approving.
                        repository.decideConfirmation(
                            sessionId = sessionId,
                            confirmationId = approvalId,
                            decision = "approve",
                            requestId = requestId,
                        )
                    }
                    runCatching { repository.refreshSessionDetail(sessionId) }
                    Outcome.Submitted
                } catch (error: Throwable) {
                    Outcome.Failed(error.message ?: "回答提交失败")
                }
            }
        }
    }

    private suspend fun readPending(sessionId: String, approvalId: String): PendingRead = try {
        repository.findPendingApproval(sessionId, approvalId)
            ?.let { PendingRead.Found(it) }
            ?: PendingRead.Missing
    } catch (error: Throwable) {
        PendingRead.Error(error.message ?: "审批状态读取失败")
    }

    private fun Approval.requiresStructuredResolution(): Boolean = batchId != null ||
        actions.any { it.needsPasskey } ||
        (passkeyRequired && !isQuestionApproval())

    private fun Approval.isQuestionApproval(): Boolean = kind.equals("question", ignoreCase = true) || questions.isNotEmpty()

    private fun Approval.resolutionQuestions(): List<ApprovalQuestion> {
        if (questions.isNotEmpty()) return questions
        val prompt = reason?.trim()?.takeIf { it.isNotEmpty() } ?: title.trim()
        if (options.isEmpty() && prompt.isEmpty()) return emptyList()
        return listOf(
            ApprovalQuestion(
                question = prompt,
                options = options.map { ApprovalOption(it) },
                isMultiSelect = isMultiSelect,
            ),
        )
    }

    private companion object {
        const val MAX_CUSTOM_ANSWER = 8_000
    }
}

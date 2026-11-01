package com.andysagent.agentoc.feature.workbench

import com.andysagent.agentoc.core.model.AttentionItem

internal data class ApprovalPresentation(val headline: String, val consequence: String?)

/** Display actual operation and consequence once; never infer safety or effects. */
internal fun approvalPresentation(item: AttentionItem): ApprovalPresentation {
    fun String?.value() = this?.trim()?.takeIf(String::isNotEmpty)
    val approval = item.approval
    val headline = sequenceOf(
        approval?.actions?.firstOrNull()?.summary,
        approval?.actions?.firstOrNull()?.description,
        item.summary, approval?.title, approval?.reason, item.title,
    ).mapNotNull { it.value() }.firstOrNull().orEmpty()
    val consequence = sequenceOf(approval?.reason, item.reason, item.summary)
        .mapNotNull { it.value() }.firstOrNull { it != headline }
    return ApprovalPresentation(headline, consequence)
}

internal fun attentionDisclosureHeight(fullHeight: Int, progress: Float): Int =
    (fullHeight.coerceAtLeast(0) * progress.coerceIn(0f, 1f)).toInt()

internal data class ApprovalDetail(val label: Int?, val value: String)

internal fun approvalDetails(item: AttentionItem, skipActionList: Boolean): List<ApprovalDetail> {
    val approval = item.approval ?: return emptyList()
    return buildList {
        fun addValue(label: Int?, value: String?) {
            value?.trim()?.takeIf(String::isNotEmpty)?.let { add(ApprovalDetail(label, it)) }
        }
        // Complete values remain available when the two-line overview truncates.
        addValue(R.string.attention_operation, approval.title)
        addValue(R.string.attention_batch, approval.batchId)
        addValue(null, approval.reason)
        if (!skipActionList) approval.actions.forEach { action ->
            val operation = action.summary?.takeIf(String::isNotBlank)
                ?: action.description.takeIf(String::isNotBlank) ?: action.command
            addValue(R.string.attention_operation, operation)
            if (action.command != operation) addValue(R.string.attention_command, action.command)
            addValue(R.string.attention_directory, action.cwd)
        }
        addValue(R.string.attention_alternative, approval.saferAlternative)
        addValue(R.string.attention_risk, approval.riskLevel)
        addValue(R.string.attention_permission, approval.permissionMode)
        addValue(R.string.attention_expiry, approval.expiresAt)
    }.distinct()
}

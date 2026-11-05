package com.andysagent.agentoc.feature.workbench

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors

@Composable
internal fun ApprovalExplanationContent(summary: String?, reason: String?, saferAlternative: String?) {
    val colors = LocalAgentocColors.current
    val entries = listOf(
        R.string.approval_explanation_summary to summary,
        R.string.approval_explanation_reason to reason,
        R.string.approval_explanation_alternative to saferAlternative,
    ).filter { !it.second.isNullOrBlank() }
    if (entries.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        entries.forEach { (label, value) ->
            Text(stringResource(label), style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold, color = colors.primaryContent)
            Text(value.orEmpty(), style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
        }
    }
}

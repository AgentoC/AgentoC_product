package com.andysagent.agentoc.feature.workbench

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.agentoc.core.designsystem.AgentoWebGlyph
import com.andysagent.agentoc.core.designsystem.AgentoWebIcon
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors
import com.andysagent.agentoc.core.designsystem.motionPolicy

@Immutable
data class DecisionQuestionUiState(
    /** Server approval/question identity. This must never be generated from UI text. */
    val id: String,
    val question: String,
    val options: List<String>,
    val optionValues: List<String> = emptyList(),
    val approvalId: String = id,
    val runId: String? = null,
    val kind: String = "question",
    val isMultiSelect: Boolean = false,
    val recommendedIndex: Int? = null,
    val selectedIndices: Set<Int> = emptySet(),
    val writeInText: String = "",
    val isSubmitted: Boolean = false,
    val isSubmitting: Boolean = false,
    val submissionError: String? = null,
)

/** Inline conversation content, not a floating navigation-glass layer. */
@Composable
fun DecisionQuestionCard(
    state: DecisionQuestionUiState,
    onOptionSelected: (Int) -> Unit,
    onWriteInChanged: (String) -> Unit,
    onSubmit: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    val editable = !state.isSubmitted && !state.isSubmitting
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        color = colors.surfaceLow,
        border = BorderStroke(0.75.dp, colors.secondaryContent.copy(alpha = 0.12f)),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = stringResource(if (state.isMultiSelect) R.string.decision_select_multiple else R.string.decision_select_one),
                    style = MaterialTheme.typography.labelMedium.copy(fontSize = 12.sp),
                    color = colors.secondaryContent,
                )
                Text(state.question, modifier = Modifier.semantics { heading() },
                    style = MaterialTheme.typography.titleMedium, color = colors.primaryContent)
            }
            Column(
                modifier = Modifier.fillMaxWidth().then(if (!state.isMultiSelect) Modifier.selectableGroup() else Modifier),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                state.options.forEachIndexed { index, optionText ->
                    // Preserve server text except the legacy trailing metadata marker.
                    val legacyRecommended = optionText.trimEnd().endsWith("(Recommended)")
                    DecisionOptionRow(
                        text = if (legacyRecommended) optionText.trimEnd().removeSuffix("(Recommended)").trimEnd() else optionText,
                        isSelected = index in state.selectedIndices,
                        isMultiSelect = state.isMultiSelect,
                        isRecommended = state.recommendedIndex == index || legacyRecommended,
                        enabled = editable,
                        onClick = { onOptionSelected(index) },
                        modifier = Modifier.testTag("decision-option-$index"),
                    )
                }
            }
            if (!state.isSubmitted) {
                val writeInLabel = stringResource(R.string.decision_write_in)
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(writeInLabel, style = MaterialTheme.typography.labelMedium, color = colors.secondaryContent)
                    BasicTextField(
                        value = state.writeInText,
                        onValueChange = onWriteInChanged,
                        enabled = editable,
                        minLines = 1,
                        maxLines = 5,
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.primaryContent),
                        cursorBrush = SolidColor(colors.accentPrimary),
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                            .clip(RoundedCornerShape(12.dp)).background(colors.surfaceHigh)
                            .testTag("decision-write-in").semantics { contentDescription = writeInLabel },
                        decorationBox = { innerField ->
                            Box(Modifier.padding(12.dp), contentAlignment = Alignment.CenterStart) { innerField() }
                        },
                    )
                }
            }
            state.submissionError?.let { error ->
                Text(error, style = MaterialTheme.typography.bodySmall, color = colors.error,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            }
            if (!state.isSubmitted) {
                Button(
                    onClick = onSubmit,
                    enabled = editable && (state.selectedIndices.isNotEmpty() || state.writeInText.isNotBlank()),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("decision-submit"),
                    shape = RoundedCornerShape(50),
                    colors = ButtonDefaults.buttonColors(containerColor = colors.actionPrimary, contentColor = colors.actionPrimaryContent),
                ) {
                    Text(stringResource(if (state.isSubmitting) R.string.decision_submitting else R.string.decision_submit),
                        style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Center)
                }
            } else {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) {
                    AgentoWebIcon(AgentoWebGlyph.Check, contentDescription = null, modifier = Modifier.size(18.dp), tint = colors.success)
                    Text(stringResource(R.string.decision_submitted), style = MaterialTheme.typography.bodyMedium, color = colors.primaryContent)
                }
            }
        }
    }
}

@Composable
private fun DecisionOptionRow(
    text: String,
    isSelected: Boolean,
    isMultiSelect: Boolean,
    isRecommended: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    val motion = motionPolicy()
    val background by animateColorAsState(
        if (isSelected) colors.actionPrimary.copy(alpha = 0.10f) else Color.Transparent,
        animationSpec = tween(motion.duration(120)), label = "decision-option-color",
    )
    val shape = RoundedCornerShape(12.dp)
    Row(
        modifier = modifier.fillMaxWidth().heightIn(min = 56.dp).clip(shape)
            .background(background)
            .border(0.75.dp, if (isSelected) colors.accentPrimary else colors.secondaryContent.copy(alpha = 0.16f), shape)
            .then(if (isMultiSelect) Modifier.toggleable(value = isSelected, enabled = enabled, role = Role.Checkbox, onValueChange = { onClick() })
                else Modifier.selectable(selected = isSelected, enabled = enabled, role = Role.RadioButton, onClick = onClick))
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        val indicatorShape = if (isMultiSelect) RoundedCornerShape(5.dp) else CircleShape
        Box(Modifier.size(20.dp).clip(indicatorShape)
            .background(if (isSelected) colors.actionPrimary else Color.Transparent)
            .then(if (!isSelected) Modifier.border(1.5.dp, colors.secondaryContent, indicatorShape) else Modifier),
            contentAlignment = Alignment.Center) {
            if (isSelected) AgentoWebIcon(AgentoWebGlyph.Check, contentDescription = null,
                modifier = Modifier.size(13.dp), tint = colors.actionPrimaryContent)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(text, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = if (isSelected) FontWeight.Medium else FontWeight.Normal),
                color = colors.primaryContent)
            if (isRecommended) Text(stringResource(R.string.decision_recommended),
                style = MaterialTheme.typography.labelMedium.copy(fontSize = 12.sp), color = colors.secondaryContent)
        }
    }
}

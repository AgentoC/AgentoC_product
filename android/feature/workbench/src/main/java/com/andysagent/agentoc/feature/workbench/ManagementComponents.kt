package com.andysagent.agentoc.feature.workbench

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.andysagent.agentoc.core.designsystem.*

/** Quiet shared surfaces for the account-wide model and runtime catalogs. */
@Composable
internal fun ManagementCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.clip(RoundedCornerShape(20.dp)).background(LocalAgentocColors.current.surfaceLow)
        .padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
}

internal fun providerRuntimeLabel(id: String): String = when (id) {
    "codex" -> "Codex"
    "claude" -> "Claude"
    "agy" -> "Antigravity"
    else -> id
}

@Composable
internal fun ManagementIdentity(glyph: AgentoWebGlyph) {
    val colors = LocalAgentocColors.current
    Box(Modifier.size(40.dp).clip(CircleShape).background(colors.accentPrimary.copy(alpha = 0.10f)),
        contentAlignment = Alignment.Center) {
        AgentoWebIcon(glyph, null, Modifier.size(22.dp), tint = colors.accentPrimary)
    }
}

@Composable
internal fun ManagementHint(text: String, glyph: AgentoWebGlyph = AgentoWebGlyph.Info) {
    val colors = LocalAgentocColors.current
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
        AgentoWebIcon(glyph, null, Modifier.padding(top = 2.dp).size(16.dp), tint = colors.secondaryContent)
        Text(text, style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
    }
}

@Composable
internal fun ManagementField(value: String, onChange: (String) -> Unit, label: String,
    enabled: Boolean, inputModifier: Modifier = Modifier) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, Modifier.padding(start = 4.dp), style = MaterialTheme.typography.labelMedium,
            color = LocalAgentocColors.current.secondaryContent)
        AgentoTextField(value, onChange, "", Modifier.fillMaxWidth(), enabled = enabled,
            inputModifier = inputModifier.semantics { contentDescription = label })
    }
}

@Composable
internal fun ManagementAction(text: String, onClick: () -> Unit, modifier: Modifier = Modifier,
    enabled: Boolean = true, secondary: Boolean = true, destructive: Boolean = false) {
    val colors = LocalAgentocColors.current
    if (secondary) {
        TextButton(onClick = onClick, enabled = enabled, modifier = modifier.heightIn(min = 48.dp),
            shape = CircleShape, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
            colors = ButtonDefaults.textButtonColors(contentColor = if (destructive) colors.error else colors.accentPrimary,
                disabledContentColor = colors.disabledContent)) {
            Text(text, style = MaterialTheme.typography.labelLarge)
        }
    } else AgentoButton(text, onClick, modifier, enabled = enabled,
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
        labelStyle = MaterialTheme.typography.labelLarge)
}

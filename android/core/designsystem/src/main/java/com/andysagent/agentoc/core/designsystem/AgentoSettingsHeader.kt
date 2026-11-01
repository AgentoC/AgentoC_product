package com.andysagent.agentoc.core.designsystem

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.agentoc.core.designsystem.theme.AgentoFrostedTokens

/** Settings navigation uses the same floating surfaces as the conversation chrome. */
@Composable
fun AgentoSettingsHeader(
    title: String,
    onBack: (() -> Unit)?,
    backDescription: String,
    modifier: Modifier = Modifier,
    backModifier: Modifier = Modifier,
    backEnabled: Boolean = true,
    subtitle: String? = null,
    onRefresh: (() -> Unit)? = null,
    refreshDescription: String = title,
    refreshing: Boolean = false,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    Row(
        modifier = modifier.fillMaxWidth().heightIn(min = 56.dp)
            .padding(horizontal = AgentocSpacing.Standard, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            AgentoFloatingIconButton(onClick = onBack, contentDescription = backDescription,
                modifier = backModifier, enabled = backEnabled, backdropTone = AgentoBackdropTone.QuietHeader,
                diffuseShadow = true) {
                AgentoWebIcon(AgentoWebGlyph.Back, null, tint = colors.floatingControlContent)
            }
        } else Spacer(Modifier.width(AgentocSpacing.TouchTarget))
        Box(Modifier.weight(1f).padding(horizontal = 8.dp), contentAlignment = Alignment.Center) {
            AgentoFrostedGlassBox(
                modifier = Modifier.widthIn(min = 100.dp, max = 250.dp).heightIn(min = 40.dp)
                    .agentoComposerShadow(AgentoShapes.PillShape),
                shape = AgentoShapes.PillShape,
                surface = AgentoGlassSurface.Neutral,
                blurRadius = AgentoFrostedTokens.BlurNavigation,
                showTopHairline = true,
                material = AgentoGlassMaterial.LiquidClear,
                backdropTone = AgentoBackdropTone.QuietHeader,
                specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
                hasShadow = false,
                contentAlignment = Alignment.Center,
            ) {
                Column(Modifier.padding(horizontal = 14.dp, vertical = 7.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(title, color = colors.primaryContent,
                        style = MaterialTheme.typography.titleMedium.copy(fontSize = 15.sp, fontWeight = FontWeight.SemiBold, lineBreak = LineBreak.Heading),
                        textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    subtitle?.takeIf { it.isNotBlank() }?.let {
                        Text(it, color = colors.secondaryContent, style = MaterialTheme.typography.labelSmall,
                            maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
                    }
                }
            }
        }
        if (onRefresh != null) {
            AgentoFloatingIconButton(onClick = onRefresh, contentDescription = refreshDescription,
                backdropTone = AgentoBackdropTone.QuietHeader, diffuseShadow = true) {
                if (refreshing) AgentoProgress(modifier = Modifier.size(20.dp))
                else AgentoWebIcon(AgentoWebGlyph.Refresh, null, tint = colors.floatingControlContent)
            }
        } else Spacer(Modifier.width(AgentocSpacing.TouchTarget))
    }
}

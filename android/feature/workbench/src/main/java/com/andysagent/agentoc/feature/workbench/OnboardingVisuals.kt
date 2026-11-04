package com.andysagent.agentoc.feature.workbench

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.agentoc.core.designsystem.*

/** Shared visual rhythm for the existing welcome, account and connection pages. */
@Composable
internal fun OnboardingPageContent(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.(compact: Boolean) -> Unit,
) {
    BoxWithConstraints(modifier.fillMaxSize()) {
        val compact = maxHeight < 640.dp || LocalDensity.current.fontScale > 1.3f
        // Anchor the illustration consistently, rather than centering each
        // differently sized stack. Short screens reclaim decorative whitespace.
        val topSpace = if (compact) 64.dp else (maxHeight * 0.14f).coerceIn(72.dp, 112.dp)
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(start = 24.dp, end = 24.dp, top = topSpace, bottom = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) { content(compact) }
    }
}

@Composable
internal fun OnboardingTextAction(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    leadingIcon: AgentoWebGlyph? = null,
) {
    val colors = LocalAgentocColors.current
    TextButton(
        onClick = onClick,
        modifier = modifier.defaultMinSize(minHeight = 48.dp),
        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 10.dp),
        colors = ButtonDefaults.textButtonColors(contentColor = colors.accentPrimary),
    ) {
        leadingIcon?.let {
            AgentoWebIcon(it, null, Modifier.size(18.dp), tint = colors.accentPrimary)
            Spacer(Modifier.width(6.dp))
        }
        Text(text, style = MaterialTheme.typography.bodyMedium.copy(
            fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium,
        ), textAlign = TextAlign.Center)
    }
}

@Composable
internal fun OnboardingDeviceTile(
    phone: Boolean,
    size: Dp = 56.dp,
) {
    val colors = LocalAgentocColors.current
    val dark = colors.canvas.red < 0.5f
    Box(
        Modifier.size(size).clip(RoundedCornerShape(16.dp))
            .background(if (dark) Color.White.copy(alpha = 0.06f) else Color.White.copy(alpha = 0.9f)),
        contentAlignment = Alignment.Center,
    ) {
        AgentoWebIcon(
            if (phone) AgentoWebGlyph.Device else AgentoWebGlyph.Monitor,
            null, Modifier.size(if (phone) 28.dp else 30.dp),
            tint = if (phone) {
                if (dark) Color(0xFFA39BFF) else Color(0xFF6559D9)
            } else colors.accentPrimary,
        )
    }
}

@Composable
internal fun OnboardingConnectionLine(modifier: Modifier = Modifier) {
    val colors = LocalAgentocColors.current
    Box(modifier.height(2.dp).clip(RoundedCornerShape(50))
        .background(Brush.horizontalGradient(listOf(
            colors.accentPrimary.copy(alpha = 0.55f), Color(0xFF8A7EE8).copy(alpha = 0.7f),
        ))))
}

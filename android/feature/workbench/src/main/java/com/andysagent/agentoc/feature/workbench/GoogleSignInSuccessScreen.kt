package com.andysagent.agentoc.feature.workbench

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.agentoc.core.designsystem.AgentoButton
import com.andysagent.agentoc.core.designsystem.AgentoWebGlyph
import com.andysagent.agentoc.core.designsystem.AgentoWebIcon
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors

@Composable
fun GoogleSignInSuccessScreen(
    action: GoogleSignInSuccessAction,
    onAction: (GoogleSignInSuccessAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.canvas),
        contentAlignment = Alignment.TopCenter,
    ) {
        Box(
            modifier = Modifier
                .widthIn(max = 440.dp)
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.statusBars.only(WindowInsetsSides.Top))
                .windowInsetsPadding(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom))
                .windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal)),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 24.dp, vertical = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                SuccessCheckMark()

                Text(
                    text = "Signed in",
                    style = MaterialTheme.typography.titleLarge.copy(
                        fontSize = 22.sp,
                        lineHeight = 28.sp,
                        fontWeight = FontWeight.SemiBold,
                    ),
                    color = colors.primaryContent,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 24.dp),
                )

                AgentoButton(
                    text = when (action) {
                        GoogleSignInSuccessAction.ConnectComputer -> "Connect a computer"
                        GoogleSignInSuccessAction.OpenSignedInWelcome -> "Continue to connect a computer"
                        GoogleSignInSuccessAction.EnterApp -> "Enter app"
                    },
                    onClick = { onAction(action) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 44.dp),
                    decision = true,
                    leadingIcon = if (action == GoogleSignInSuccessAction.OpenSignedInWelcome) {
                        null
                    } else {
                        {
                            AgentoWebIcon(
                                glyph = when (action) {
                                    GoogleSignInSuccessAction.ConnectComputer -> AgentoWebGlyph.MonitorPlus
                                    GoogleSignInSuccessAction.EnterApp -> AgentoWebGlyph.Home
                                    GoogleSignInSuccessAction.OpenSignedInWelcome -> error("Icon is not rendered for this action")
                                },
                                contentDescription = null,
                                modifier = Modifier.size(18.dp),
                                tint = colors.actionPrimaryContent,
                            )
                        }
                    },
                )
            }
        }
    }
}

@Composable
private fun SuccessCheckMark(modifier: Modifier = Modifier) {
    val colors = LocalAgentocColors.current
    val ringProgress = remember { Animatable(0f) }
    val checkProgress = remember { Animatable(0f) }

    LaunchedEffect(Unit) {
        ringProgress.animateTo(
            targetValue = 1f,
            animationSpec = tween(durationMillis = 520, easing = FastOutSlowInEasing),
        )
        checkProgress.animateTo(
            targetValue = 1f,
            animationSpec = tween(durationMillis = 360, easing = LinearOutSlowInEasing),
        )
    }

    Canvas(
        modifier = modifier
            .size(132.dp)
            .semantics { contentDescription = "Signed in successfully" },
    ) {
        val strokeWidth = 6.dp.toPx()
        val checkStrokeWidth = 6.5.dp.toPx()
        val centerX = size.width / 2f
        val centerY = size.height / 2f
        val unit = size.minDimension / 132f

        drawArc(
            color = colors.success,
            startAngle = -90f,
            sweepAngle = -360f * ringProgress.value,
            useCenter = false,
            style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
        )

        val checkPath = Path().apply {
            moveTo(centerX - 29f * unit, centerY + 1f * unit)
            lineTo(centerX - 8f * unit, centerY + 22f * unit)
            lineTo(centerX + 31f * unit, centerY - 23f * unit)
        }
        val measure = PathMeasure().apply { setPath(checkPath, false) }
        val visibleCheck = Path()
        measure.getSegment(
            startDistance = 0f,
            stopDistance = measure.length * checkProgress.value,
            destination = visibleCheck,
            startWithMoveTo = true,
        )
        drawPath(
            path = visibleCheck,
            color = colors.success,
            style = Stroke(
                width = checkStrokeWidth,
                cap = StrokeCap.Round,
                join = StrokeJoin.Round,
            ),
        )
    }
}

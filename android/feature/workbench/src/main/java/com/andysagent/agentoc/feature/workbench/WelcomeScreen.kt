package com.andysagent.agentoc.feature.workbench

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.ui.graphics.Brush
import com.andysagent.agentoc.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.agentoc.core.designsystem.AgentoGlassSurface
import com.andysagent.agentoc.core.designsystem.AgentoGlassMaterial
import com.andysagent.agentoc.core.designsystem.theme.AgentoFrostedTokens
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.testTag
import com.andysagent.agentoc.core.designsystem.AgentoTextAction
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.agentoc.core.designsystem.AgentoButton
import com.andysagent.agentoc.core.designsystem.AgentoIconButton
import com.andysagent.agentoc.core.designsystem.AgentoSpacing
import com.andysagent.agentoc.core.designsystem.AgentoWebGlyph
import com.andysagent.agentoc.core.designsystem.AgentoWebIcon
import com.andysagent.agentoc.core.designsystem.AgentocTextStyles
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors

@Composable
fun WelcomeScreen(
    onConnectComputer: () -> Unit,
    onScanPairing: () -> Unit,
    signedIn: Boolean = false,
    onLearnConnectionMethods: () -> Unit = {},
    onSkip: () -> Unit = {},
    onDemoSignIn: (() -> Unit)? = null,
    onSetUpComputer: () -> Unit = onScanPairing,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.canvas),
        contentAlignment = Alignment.Center,
    ) {
        BoxWithConstraints(
            modifier = Modifier
                .widthIn(max = 480.dp)
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.statusBars.only(WindowInsetsSides.Top))
                .windowInsetsPadding(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom))
                .windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal)),
        ) {
            WelcomeConnectionContent(
                signedIn = signedIn,
                onConnectComputer = onConnectComputer,
                onScanPairing = onScanPairing,
                onLearnConnectionMethods = onLearnConnectionMethods,
                onSkip = onSkip,
                onDemoSignIn = onDemoSignIn,
                onSetUpComputer = onSetUpComputer,
            )
        }
    }
}

/** Connection is a distinct signed-in page; authentication is rendered by its own screen. */
@Composable
private fun WelcomeConnectionContent(
    signedIn: Boolean,
    onConnectComputer: () -> Unit,
    onScanPairing: () -> Unit,
    onLearnConnectionMethods: () -> Unit,
    onSkip: () -> Unit,
    onDemoSignIn: (() -> Unit)?,
    onSetUpComputer: () -> Unit,
) {
    val colors = LocalAgentocColors.current
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 48.dp).testTag("connect-computer-page"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        DeviceRelationship()
        Spacer(Modifier.height(32.dp))
        Text(stringResource(R.string.journey_connect_title),
            style = MaterialTheme.typography.headlineMedium, color = colors.primaryContent,
            textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(12.dp))
        Text(stringResource(R.string.journey_connect_summary),
            style = MaterialTheme.typography.bodyMedium, color = colors.secondaryContent,
            textAlign = TextAlign.Center)
        Spacer(Modifier.height(32.dp))
        AgentoButton(stringResource(R.string.journey_setup_computer), onClick = onSetUpComputer,
            modifier = Modifier.widthIn(min = 180.dp, max = 280.dp).testTag("connect-my-computer"),
            decision = true, labelMaxLines = 2,
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 24.dp, vertical = 12.dp))
    }
}

enum class AccountComputerLookup { Loading, Empty, Available, Failed }

@Composable
fun AccountComputerLookupScreen(state: AccountComputerLookup, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    val colors = LocalAgentocColors.current
    Column(modifier.fillMaxSize().background(colors.canvas).padding(24.dp)
        .testTag("account-computer-lookup"), verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally) {
        Text(stringResource(if (state == AccountComputerLookup.Failed) R.string.journey_devices_failed else R.string.journey_devices_loading),
            style = MaterialTheme.typography.titleMedium, color = colors.primaryContent,
            textAlign = TextAlign.Center)
        if (state == AccountComputerLookup.Failed) {
            Spacer(Modifier.height(24.dp))
            AgentoButton(stringResource(R.string.journey_devices_retry), onClick = onRetry,
                modifier = Modifier.testTag("retry-account-computers"))
        }
    }
}

/** Keeps launch on the onboarding route while persisted setup state is loading. */
@Composable
fun WelcomeLaunchScreen(modifier: Modifier = Modifier) {
    val colors = LocalAgentocColors.current
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.canvas)
            .windowInsetsPadding(WindowInsets.statusBars.only(WindowInsetsSides.Top))
            .windowInsetsPadding(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "AgentoC",
            style = AgentocTextStyles.brandDisplay,
            color = colors.primaryContent,
        )
    }
}

@Composable
fun ConnectionMethodsScreen(
    onBack: () -> Unit,
    onTryDirectConnection: () -> Unit = {},
    onScanTemporary: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.canvas),
        contentAlignment = Alignment.TopCenter,
    ) {
        BoxWithConstraints(
            modifier = Modifier
                .widthIn(max = 440.dp)
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.statusBars.only(WindowInsetsSides.Top))
                .windowInsetsPadding(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom))
                .windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal)),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = maxHeight)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.SpaceBetween,
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 56.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AgentoIconButton(
                        onClick = onBack,
                        contentDescription = stringResource(R.string.pairing_back),
                    ) {
                        AgentoWebIcon(
                            glyph = AgentoWebGlyph.Back,
                            contentDescription = null,
                            modifier = Modifier.size(22.dp),
                            tint = colors.primaryContent,
                        )
                    }
                }

                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 32.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        text = stringResource(R.string.journey_temporary_entry),
                        style = MaterialTheme.typography.headlineMedium.copy(
                            fontSize = 30.sp,
                            lineHeight = 36.sp,
                            fontWeight = FontWeight.SemiBold,
                        ),
                        color = colors.primaryContent,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.semantics { heading() },
                    )
                    Spacer(Modifier.height(16.dp))
                    Text(
                        text = stringResource(R.string.journey_temporary_instructions),
                        style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 22.sp),
                        color = colors.secondaryContent,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.widthIn(max = 336.dp),
                    )
                }

                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    AgentoButton(
                        text = stringResource(R.string.temporary_pairing_scan),
                        onClick = onScanTemporary,
                        modifier = Modifier.widthIn(max = 280.dp), labelMaxLines = 2,
                    )
                    AgentoTextAction(stringResource(R.string.pairing_back), onBack)
                }
            }
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun WelcomePreview() {
    AgentocTheme {
        WelcomeScreen(
            onConnectComputer = {},
            onScanPairing = {},
        )
    }
}

@Preview(showBackground = true, widthDp = 320, heightDp = 640)
@Preview(showBackground = true, widthDp = 840, heightDp = 900, uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun SignedInWelcomePreview() {
    AgentocTheme {
        WelcomeScreen(
            onConnectComputer = {},
            onScanPairing = {},
            signedIn = true,
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun ConnectionMethodsPreview() {
    AgentocTheme {
        ConnectionMethodsScreen(onBack = {})
    }
}

@Composable
private fun DeviceRelationship(modifier: Modifier = Modifier) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    val stageShape = RoundedCornerShape(30.dp)
    val tileShape = RoundedCornerShape(16.dp)

    AgentoFrostedGlassBox(
        modifier = modifier
            .width(204.dp)
            .height(104.dp),
        shape = stageShape,
        surface = AgentoGlassSurface.BrushOverlay(if (isDark) AgentoFrostedTokens.DarkDockGlassBrush else AgentoFrostedTokens.LightDockGlassBrush),
        showTopHairline = true,
        blurRadius = AgentoFrostedTokens.BlurNavigation,
        material = AgentoGlassMaterial.LiquidClear,
        hasShadow = true,
        shadowElevation = 8.dp,
    ) {
        Box(modifier = Modifier.fillMaxSize()) {
            // Computer / Host tile
            Box(
                modifier = Modifier
                    .align(Alignment.CenterStart)
                    .padding(start = 16.dp)
                    .size(58.dp)
                    .clip(tileShape)
                    .background(if (isDark) AgentoFrostedTokens.SurfaceLevel2 else Color.White),
                contentAlignment = Alignment.Center,
            ) {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.Monitor,
                    contentDescription = null,
                    modifier = Modifier.size(30.dp),
                    tint = Color(0xFF0A84FF),
                )
            }

            // Connection bridge with gradient
            Box(
                modifier = Modifier
                    .align(Alignment.Center)
                    .width(48.dp)
                    .height(3.dp)
                    .clip(RoundedCornerShape(99.dp))
                    .background(
                        Brush.horizontalGradient(
                            listOf(
                                Color(0xFF0A84FF).copy(alpha = 0.7f),
                                Color(0xFF5E5CE6).copy(alpha = 0.9f),
                                Color(0xFF0A84FF).copy(alpha = 0.7f),
                            ),
                        ),
                    ),
            )

            // Phone / Device tile
            Box(
                modifier = Modifier
                    .align(Alignment.CenterEnd)
                    .padding(end = 16.dp)
                    .size(58.dp)
                    .clip(tileShape)
                    .background(if (isDark) AgentoFrostedTokens.SurfaceLevel2 else Color.White),
                contentAlignment = Alignment.Center,
            ) {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.Device,
                    contentDescription = null,
                    modifier = Modifier.size(28.dp),
                    tint = Color(0xFF5E5CE6),
                )
            }
        }
    }
}

@Composable
private fun QuietAction(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    TextButton(
        onClick = onClick,
        modifier = modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 48.dp),
        colors = ButtonDefaults.textButtonColors(contentColor = colors.secondaryContent),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium.copy(
                fontSize = 15.sp,
                lineHeight = 20.sp,
                fontWeight = FontWeight.Medium,
            ),
            color = colors.accentPrimary,
            textAlign = TextAlign.Center,
        )
    }
}

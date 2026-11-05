package com.andysagent.agentoc.feature.workbench

import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.ui.graphics.Brush
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.agentoc.core.designsystem.AgentoButton
import com.andysagent.agentoc.core.designsystem.AgentoIconButton
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

/** The welcome entry opens account sign-in; signed-in setup remains a separate destination. */
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
    OnboardingPageContent(
        Modifier.testTag(if (signedIn) "connect-computer-page" else "welcome-entry-page"),
        footer = {
            if (!signedIn) {
                OnboardingTextAction(stringResource(R.string.journey_temporary_entry), onLearnConnectionMethods,
                    Modifier.testTag("temporary-access-entry"), quiet = true)
            }
        },
    ) { compact ->
        if (signedIn) {
            DeviceRelationship(compact = compact)
        } else {
            AccountConnectionIllustration(compact = compact)
        }
        Spacer(Modifier.height(if (compact) 28.dp else 36.dp))
        Text(stringResource(if (signedIn) R.string.journey_connect_title else R.string.welcome_connect_title),
            style = MaterialTheme.typography.headlineMedium.copy(
                fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.SemiBold,
                letterSpacing = (-0.4).sp,
            ), color = colors.primaryContent,
            textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(12.dp))
        Text(stringResource(if (signedIn) R.string.journey_connect_summary else R.string.welcome_value_summary),
            style = MaterialTheme.typography.bodyMedium.copy(
                fontSize = 15.sp, lineHeight = 24.sp, lineBreak = LineBreak.Heading,
            ), color = colors.secondaryContent,
            textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 304.dp))
        Spacer(Modifier.height(if (compact) 28.dp else 40.dp))
        AgentoButton(stringResource(if (signedIn) R.string.journey_setup_computer else R.string.settings_sign_in),
            onClick = if (signedIn) onSetUpComputer else onConnectComputer,
            modifier = Modifier.widthIn(min = 200.dp, max = 280.dp)
                .testTag(if (signedIn) "connect-my-computer" else "welcome-sign-in"),
            decision = true, labelMaxLines = 2,
            labelStyle = MaterialTheme.typography.labelLarge.copy(fontSize = 16.sp, lineHeight = 22.sp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 24.dp, vertical = 12.dp))
        if (!signedIn) {
            Spacer(Modifier.height(8.dp))
            OnboardingTextAction(stringResource(R.string.journey_reverse_sign_in), onScanPairing,
                Modifier.widthIn(max = 288.dp).testTag("sign-in-from-computer"), quiet = true)
        }
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
private fun DeviceRelationship(modifier: Modifier = Modifier, compact: Boolean = false) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    Box(
        modifier = modifier
            .width(if (compact) 204.dp else 220.dp)
            .height(if (compact) 80.dp else 104.dp)
            .clip(RoundedCornerShape(30.dp))
            .background(Brush.verticalGradient(listOf(
                Color.White.copy(alpha = if (isDark) 0.045f else 0.65f),
                Color.White.copy(alpha = if (isDark) 0.015f else 0.25f),
            ))),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            OnboardingDeviceTile(phone = false)
            OnboardingConnectionLine(Modifier.width(if (compact) 48.dp else 64.dp))
            OnboardingDeviceTile(phone = true)
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

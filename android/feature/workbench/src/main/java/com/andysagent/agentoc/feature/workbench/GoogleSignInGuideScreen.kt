package com.andysagent.agentoc.feature.workbench

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
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
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors

@Composable
fun GoogleSignInGuideScreen(
    onContinue: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    onContinueWithBrowser: (() -> Unit)? = null,
    onContinueWithDemo: (() -> Unit)? = null,
) {
    val colors = LocalAgentocColors.current

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.canvas).testTag("account-sign-in-page"),
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
            OnboardingPageContent { compact ->
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box(Modifier.heightIn(min = if (compact) 80.dp else 104.dp), contentAlignment = Alignment.Center) {
                        AccountConnectionPath()
                    }
                    Spacer(Modifier.height(if (compact) 20.dp else 28.dp))
                    Text(
                        text = stringResource(R.string.journey_login_title),
                        style = MaterialTheme.typography.headlineMedium.copy(
                            fontSize = 28.sp,
                            lineHeight = 36.sp,
                            fontWeight = FontWeight.SemiBold,
                            letterSpacing = (-0.4).sp,
                        ),
                        color = colors.primaryContent,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.semantics { heading() },
                    )

                    Spacer(Modifier.height(if (compact) 24.dp else 36.dp))
                }

                Column(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    AgentoButton(
                        text = stringResource(R.string.sign_in_guide_continue_with_google),
                        onClick = onContinue,
                        modifier = Modifier.widthIn(min = 200.dp, max = 280.dp).testTag("account-sign-in-primary"),
                        labelMaxLines = 2,
                        labelStyle = MaterialTheme.typography.labelLarge.copy(
                            fontSize = 16.sp, lineHeight = 22.sp, lineBreak = LineBreak.Heading,
                        ),
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 24.dp, vertical = 12.dp),
                        decision = true,
                        leadingIcon = {
                            Box(Modifier.size(28.dp).clip(CircleShape).background(androidx.compose.ui.graphics.Color.White),
                                contentAlignment = Alignment.Center) { GoogleBrandIcon(Modifier.size(18.dp)) }
                        },
                    )


                    Spacer(Modifier.height(8.dp))
                    onContinueWithBrowser?.let { browser ->
                        OnboardingTextAction(stringResource(R.string.sign_in_guide_continue_with_browser), browser)
                    }
                    onContinueWithDemo?.let { demo ->
                        OnboardingTextAction(stringResource(R.string.demo_sign_in_title), demo)
                    }
                }
            }
            SignInTopBar(onBack = onBack,
                modifier = Modifier.align(Alignment.TopStart).background(colors.canvas).padding(horizontal = 24.dp))
        }
    }
}

@Composable
private fun SignInTopBar(
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    Box(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        AgentoIconButton(
            onClick = onBack,
            contentDescription = stringResource(R.string.welcome_back_to_connection),
        ) {
            AgentoWebIcon(
                glyph = AgentoWebGlyph.Back,
                contentDescription = null,
                modifier = Modifier.size(22.dp),
                tint = colors.primaryContent,
            )
        }
    }
}

@Composable
private fun AccountConnectionPath(modifier: Modifier = Modifier) {
    val colors = LocalAgentocColors.current
    val connectionPathDescription = stringResource(R.string.sign_in_guide_connection_path_description)
    Row(
        modifier = modifier
            .widthIn(max = 288.dp)
            .fillMaxWidth()
            .semantics {
                contentDescription = connectionPathDescription
            },
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.Center,
    ) {
        ConnectionNode(
            modifier = Modifier.weight(1f),
            label = stringResource(R.string.welcome_computer),
            icon = { OnboardingDeviceTile(phone = false, size = 52.dp) },
        )
        ConnectionLine()
        ConnectionNode(
            modifier = Modifier.weight(1f),
            label = stringResource(R.string.sign_in_guide_google_account),
            icon = {
                Box(Modifier.size(52.dp).clip(CircleShape).background(colors.quietSurface),
                    contentAlignment = Alignment.Center) { GoogleBrandIcon(Modifier.size(24.dp)) }
            },
        )
        ConnectionLine()
        ConnectionNode(
            modifier = Modifier.weight(1f),
            label = stringResource(R.string.welcome_this_phone),
            icon = { OnboardingDeviceTile(phone = true, size = 52.dp) },
        )
    }
}

@Composable
private fun ConnectionNode(
    label: String,
    icon: @Composable () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        icon()
        if (LocalDensity.current.fontScale <= 1.3f) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium.copy(
                    fontSize = 13.sp,
                    lineHeight = 18.sp,
                    fontWeight = FontWeight.Normal,
                ),
                color = colors.secondaryContent,
                textAlign = TextAlign.Center,
                minLines = 2,
            )
        }
    }
}

@Composable
private fun ConnectionLine(modifier: Modifier = Modifier) {
    OnboardingConnectionLine(
        modifier = modifier
            .padding(top = 25.dp)
            .width(16.dp),
    )
}

@Preview(name = "Google sign-in guide", showBackground = true, widthDp = 320, heightDp = 640)
@Preview(name = "Expanded sign-in", showBackground = true, widthDp = 840, heightDp = 900)
@Composable
private fun GoogleSignInGuidePreview() {
    AgentocTheme {
        GoogleSignInGuideScreen(onContinue = {}, onBack = {})
    }
}

@Preview(
    name = "Google sign-in guide dark",
    showBackground = true,
    widthDp = 390,
    heightDp = 844,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
)
@Composable
private fun GoogleSignInGuideDarkPreview() {
    AgentocTheme(darkTheme = true) {
        GoogleSignInGuideScreen(onContinue = {}, onBack = {})
    }
}

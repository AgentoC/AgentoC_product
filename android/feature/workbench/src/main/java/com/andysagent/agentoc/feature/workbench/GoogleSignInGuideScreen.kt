package com.andysagent.agentoc.feature.workbench

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
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
                SignInTopBar(onBack = onBack)

                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 48.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        text = stringResource(R.string.sign_in_guide_title),
                        style = MaterialTheme.typography.headlineMedium.copy(
                            fontSize = 32.sp,
                            lineHeight = 36.sp,
                            fontWeight = FontWeight.SemiBold,
                        ),
                        color = colors.primaryContent,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.semantics { heading() },
                    )

                    Spacer(Modifier.height(44.dp))

                    AccountConnectionPath()
                }

                Column(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    AgentoButton(
                        text = stringResource(R.string.sign_in_guide_continue_with_google),
                        onClick = onContinue,
                        modifier = Modifier.fillMaxWidth(),
                        decision = true,
                        leadingIcon = { GoogleBrandIcon() },
                    )

                    onContinueWithDemo?.let { onDemo ->
                        androidx.compose.material3.TextButton(onClick = onDemo) {
                            Text(stringResource(R.string.demo_sign_in_title))
                        }
                    }
                    if (onContinueWithBrowser != null) {
                        Spacer(Modifier.height(12.dp))
                        Text(
                            text = stringResource(R.string.sign_in_guide_continue_with_browser),
                            style = MaterialTheme.typography.labelLarge.copy(
                                fontSize = 14.sp,
                                lineHeight = 20.sp,
                                fontWeight = FontWeight.SemiBold,
                            ),
                            color = colors.tertiaryContent,
                            textAlign = TextAlign.Center,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(12.dp))
                                .clickable(onClick = onContinueWithBrowser)
                                .padding(vertical = 10.dp),
                        )
                        Text(
                            text = stringResource(R.string.sign_in_guide_continue_with_browser_hint),
                            style = MaterialTheme.typography.bodySmall.copy(
                                fontSize = 12.sp,
                                lineHeight = 17.sp,
                            ),
                            color = colors.tertiaryContent,
                            textAlign = TextAlign.Center,
                            modifier = Modifier
                                .widthIn(max = 320.dp)
                                .padding(top = 2.dp),
                        )
                    }
                }
            }
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
            .fillMaxWidth()
            .semantics {
                contentDescription = connectionPathDescription
            },
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.Center,
    ) {
        ConnectionNode(
            label = stringResource(R.string.welcome_computer),
            icon = {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.Monitor,
                    contentDescription = null,
                    modifier = Modifier.size(22.dp),
                    tint = colors.primaryContent,
                )
            },
        )
        ConnectionLine()
        ConnectionNode(
            label = stringResource(R.string.sign_in_guide_google_account),
            emphasized = true,
            icon = { GoogleBrandIcon() },
        )
        ConnectionLine()
        ConnectionNode(
            label = stringResource(R.string.welcome_this_phone),
            icon = {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.Device,
                    contentDescription = null,
                    modifier = Modifier.size(22.dp),
                    tint = colors.primaryContent,
                )
            },
        )
    }
}

@Composable
private fun ConnectionNode(
    label: String,
    icon: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    emphasized: Boolean = false,
) {
    val colors = LocalAgentocColors.current
    Column(
        modifier = modifier.width(88.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            modifier = Modifier
                .size(if (emphasized) 52.dp else 44.dp)
                .clip(if (emphasized) CircleShape else RoundedCornerShape(13.dp))
                .background(if (emphasized) colors.strongSurface else colors.quietSurface),
            contentAlignment = Alignment.Center,
        ) {
            icon()
        }
        Spacer(Modifier.height(10.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium.copy(
                fontSize = 14.sp,
                lineHeight = 18.sp,
                fontWeight = if (emphasized) FontWeight.SemiBold else FontWeight.Medium,
            ),
            color = colors.primaryContent,
            textAlign = TextAlign.Center,
            minLines = 2,
            maxLines = 2,
        )
    }
}

@Composable
private fun ConnectionLine(modifier: Modifier = Modifier) {
    val colors = LocalAgentocColors.current
    Box(
        modifier = modifier
            .padding(top = 25.dp)
            .width(22.dp)
            .height(1.dp)
            .background(colors.tertiaryContent.copy(alpha = 0.5f)),
    )
}

@Preview(name = "Google sign-in guide", showBackground = true, widthDp = 390, heightDp = 844)
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

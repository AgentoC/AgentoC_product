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
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalDensity
import com.andysagent.agentoc.core.designsystem.AgentoTextAction
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
    onScanSignedInComputer: (() -> Unit)? = null,
    onTemporaryAccess: (() -> Unit)? = null,
    showBack: Boolean = true,
) {
    val colors = LocalAgentocColors.current
    var otherSignInMethods by rememberSaveable { mutableStateOf(false) }

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
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = maxHeight)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.Center,
            ) {
                if (showBack) SignInTopBar(onBack = onBack)

                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 32.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        text = stringResource(R.string.journey_login_title),
                        style = MaterialTheme.typography.headlineMedium.copy(
                            fontSize = 28.sp,
                            lineHeight = 36.sp,
                            fontWeight = FontWeight.SemiBold,
                        ),
                        color = colors.primaryContent,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.semantics { heading() },
                    )

                    Spacer(Modifier.height(24.dp))

                    AccountConnectionPath()
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
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 24.dp, vertical = 12.dp),
                        decision = true,
                        leadingIcon = { GoogleBrandIcon() },
                    )


                    onScanSignedInComputer?.let { scan ->
                        Spacer(Modifier.height(12.dp))
                        AgentoTextAction(stringResource(R.string.journey_reverse_sign_in), scan,
                            Modifier.testTag("sign-in-from-computer"))
                    }
                    if (onContinueWithDemo != null || onContinueWithBrowser != null) {
                        AgentoTextAction(stringResource(R.string.journey_other_sign_in),
                            { otherSignInMethods = !otherSignInMethods }, Modifier.testTag("other-sign-in-methods"))
                        if (otherSignInMethods) {
                            onContinueWithBrowser?.let { browser ->
                                AgentoTextAction(stringResource(R.string.sign_in_guide_continue_with_browser), browser)
                            }
                            onContinueWithDemo?.let { demo ->
                                AgentoTextAction(stringResource(R.string.demo_sign_in_title), demo)
                            }
                        }
                    }
                    onTemporaryAccess?.let { temporary ->
                        Spacer(Modifier.height(24.dp))
                        AgentoTextAction(stringResource(R.string.journey_temporary_entry), temporary,
                            Modifier.testTag("temporary-access-entry"))
                    }
                    Spacer(Modifier.height(24.dp))
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
            modifier = Modifier.weight(1f),
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
            modifier = Modifier.weight(1f),
            label = stringResource(R.string.sign_in_guide_google_account),
            emphasized = true,
            icon = { GoogleBrandIcon() },
        )
        ConnectionLine()
        ConnectionNode(
            modifier = Modifier.weight(1f),
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
        modifier = modifier,
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
        if (LocalDensity.current.fontScale <= 1.3f) {
        Spacer(Modifier.height(12.dp))
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
        )
        }
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

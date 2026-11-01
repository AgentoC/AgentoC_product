package com.andysagent.agentoc.feature.workbench

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.statusBars
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.model.RuntimeCatalog

val LocalRestrictedDemoEnvironment = staticCompositionLocalOf { false }

private fun isDemoModel(value: String) = value.substringBeforeLast('@', value) == "gpt-5.6-luna"

/** UI projection only. The computer independently enforces its immutable policy. */
fun restrictDemoRuntimeCatalog(value: RuntimeCatalog, restricted: Boolean): RuntimeCatalog {
    if (!restricted) return value
    return value.copy(tools = value.tools.filter { it.id == "codex" }.map { tool ->
        tool.copy(models = tool.models.filter { isDemoModel(it.id) })
    })
}

fun restrictDemoWorkbenchState(value: WorkbenchUiState, restricted: Boolean): WorkbenchUiState {
    if (!restricted) return value
    return value.copy(
        runtimeCatalog = restrictDemoRuntimeCatalog(value.runtimeCatalog, true),
        runtimeTool = "codex",
        runtimeModel = value.runtimeModel?.takeIf(::isDemoModel),
        runtimeSelectionDisplay = value.runtimeSelectionDisplay.takeIf {
            value.runtimeTool == "codex" && (value.runtimeModel == null || isDemoModel(value.runtimeModel))
        },
    )
}

fun restrictDemoParityState(value: WebParityUiState, restricted: Boolean): WebParityUiState {
    if (!restricted) return value
    return value.copy(
        harnesses = value.harnesses.filter { it.id == "codex" && it.installed },
        providers = value.providers.filter { it.agentType == "codex" && it.authType == "oauth" },
        availableTools = value.availableTools.filter { it == "codex" },
    )
}

@Composable
fun DemoEnvironmentNotice(modifier: Modifier = Modifier, restricted: Boolean = true) {
    Surface(modifier.fillMaxWidth().testTag(if (restricted) "restricted-demo-notice" else "full-demo-notice"), color = MaterialTheme.colorScheme.secondaryContainer) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
            Text(stringResource(if (restricted) R.string.demo_environment_title else R.string.demo_environment_full_title), style = MaterialTheme.typography.labelLarge)
            Text(stringResource(if (restricted) R.string.demo_environment_limits else R.string.demo_sign_in_description), style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
fun DemoEnvironmentSurface(
    restricted: Boolean,
    connection: com.andysagent.agentoc.feature.workbench.accounts.DemoConnectionUiState? = null,
    onRetryConnection: () -> Unit = {},
    onSignOut: () -> Unit = {},
    testAccount: Boolean = restricted,
    content: @Composable () -> Unit,
) {
    var connectionDismissed by remember(connection?.targetId) { mutableStateOf(false) }
    CompositionLocalProvider(LocalRestrictedDemoEnvironment provides restricted) {
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f)) {
                val showConnection = testAccount && connection != null && !connection.ready && !connectionDismissed
                Box(Modifier.fillMaxSize()) {
                    content()
                }
                if (showConnection && connection != null) {
                    com.andysagent.agentoc.feature.workbench.accounts.DemoConnectionGate(connection, onRetryConnection, { connectionDismissed = true })
                }
            }
        }
    }
}

@Preview(showBackground = true, widthDp = 390)
@Composable
private fun DemoEnvironmentNoticePreview() {
    AgentocTheme { DemoEnvironmentNotice() }
}

@Preview(showBackground = true, widthDp = 320)
@Composable
private fun FullDemoEnvironmentNoticePreview() {
    AgentocTheme { DemoEnvironmentNotice(restricted = false) }
}

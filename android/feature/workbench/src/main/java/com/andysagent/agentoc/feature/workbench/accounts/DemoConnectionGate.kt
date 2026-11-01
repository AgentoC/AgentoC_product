package com.andysagent.agentoc.feature.workbench.accounts

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.designsystem.AgentoConnectionProgress
import com.andysagent.agentoc.feature.workbench.R

/** Floating connection status; the workbench stays mounted beneath it. */
@Composable
fun DemoConnectionGate(state: DemoConnectionUiState, onRetry: () -> Unit, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    AgentoConnectionProgress(
        title = stringResource(when (state.phase) {
            DemoConnectionPhase.Discovering -> R.string.demo_connection_finding
            DemoConnectionPhase.Reconnecting -> R.string.demo_connection_reconnecting
            DemoConnectionPhase.Unavailable -> R.string.demo_connection_unavailable
            else -> R.string.demo_connection_connecting
        }),
        detail = stringResource(if (state.takingLonger) R.string.demo_connection_slow else R.string.demo_connection_detail),
        busy = state.phase != DemoConnectionPhase.Unavailable,
        showRetry = state.phase == DemoConnectionPhase.Unavailable || state.takingLonger,
        retryLabel = stringResource(R.string.demo_connection_retry),
        exitLabel = stringResource(R.string.demo_connection_close),
        onRetry = onRetry,
        onExit = onDismiss,
        modifier = modifier.testTag("demo-connection-gate"),
    )
}

@Preview(showBackground = true, widthDp = 320, heightDp = 568)
@Preview(showBackground = true, widthDp = 840, heightDp = 720)
@Preview(showBackground = true, widthDp = 390, heightDp = 720, uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun DemoConnectionGatePreview() {
    AgentocTheme { DemoConnectionGate(DemoConnectionUiState(active = true), {}, {}) }
}

@Preview(showBackground = true, widthDp = 390, heightDp = 720)
@Preview(showBackground = true, widthDp = 840, heightDp = 720, uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun DemoConnectionRecoveryPreview() {
    AgentocTheme { DemoConnectionGate(DemoConnectionUiState(active = true,
        phase = DemoConnectionPhase.Reconnecting, elapsedMillis = 5_100), {}, {}) }
}

@Preview(showBackground = true, widthDp = 320, heightDp = 568)
@Composable
private fun DemoConnectionUnavailablePreview() {
    AgentocTheme { DemoConnectionGate(DemoConnectionUiState(active = true,
        phase = DemoConnectionPhase.Unavailable), {}, {}) }
}

package com.andysagent.agentoc

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import com.andysagent.agentoc.core.appapi.ApiErrorCode
import com.andysagent.agentoc.core.datastore.LinkedComputer
import com.andysagent.agentoc.core.designsystem.AgentocTheme

@Composable
internal fun SessionNavigationDialog(error: ApiErrorCode?, computers: List<LinkedComputer>, choose: (String) -> Unit, dismiss: () -> Unit) {
    AlertDialog(onDismissRequest = dismiss,
        title = { Text(stringResource(if (error == null) R.string.navigation_choose_computer else R.string.navigation_cannot_open)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(stringResource(when (error) {
                    null -> if (computers.isEmpty()) R.string.navigation_no_computers else R.string.navigation_legacy_source
                    ApiErrorCode.TARGET_NOT_FOUND -> R.string.navigation_target_missing
                    ApiErrorCode.RESOURCE_NOT_FOUND -> R.string.navigation_session_missing
                    ApiErrorCode.PERMISSION_DENIED, ApiErrorCode.AUTHENTICATION_REQUIRED -> R.string.navigation_not_authorized
                    ApiErrorCode.INVALID_ARGUMENT, ApiErrorCode.CAPABILITY_UNSUPPORTED -> R.string.navigation_invalid
                    else -> R.string.navigation_unavailable
                }))
                if (error == null) computers.forEach { computer ->
                    TextButton(onClick = { choose(computer.instanceId) }) { Text(computer.label.ifBlank { computer.instanceId }) }
                }
            }
        },
        confirmButton = { TextButton(onClick = dismiss) { Text(stringResource(R.string.navigation_close)) } },
    )
}

@Preview @Composable private fun ChooseNavigationComputerPreview() {
    AgentocTheme { SessionNavigationDialog(null, listOf(LinkedComputer("a", "", "Office"), LinkedComputer("b", "", "Home")), {}, {}) }
}
@Preview @Composable private fun MissingNavigationSessionPreview() {
    AgentocTheme(darkTheme = true) { SessionNavigationDialog(ApiErrorCode.RESOURCE_NOT_FOUND, emptyList(), {}, {}) }
}

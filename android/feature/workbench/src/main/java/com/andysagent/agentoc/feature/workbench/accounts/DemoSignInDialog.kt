package com.andysagent.agentoc.feature.workbench.accounts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.feature.workbench.R

@Composable
fun DemoSignInDialog(
    state: DemoSignInUiState,
    onUsernameChanged: (String) -> Unit,
    onPasswordChanged: (String) -> Unit,
    onSubmit: () -> Unit,
    onDismiss: () -> Unit,
) {
    if (!state.open) return
    AlertDialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(dismissOnBackPress = !state.busy, dismissOnClickOutside = !state.busy),
        title = { Text(stringResource(R.string.demo_sign_in_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.demo_sign_in_description))
                OutlinedTextField(value = state.username, onValueChange = onUsernameChanged,
                    label = { Text(stringResource(R.string.demo_sign_in_username)) },
                    enabled = !state.busy, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false))
                OutlinedTextField(value = state.password, onValueChange = onPasswordChanged,
                    label = { Text(stringResource(R.string.demo_sign_in_password)) },
                    enabled = !state.busy, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
                state.error?.let { error ->
                    Text(stringResource(when (error) {
                        DemoSignInError.Credentials -> R.string.demo_sign_in_error_credentials
                        DemoSignInError.Unavailable -> R.string.demo_sign_in_error_unavailable
                        DemoSignInError.RateLimited -> R.string.demo_sign_in_error_rate
                        DemoSignInError.Network -> R.string.demo_sign_in_error_network
                        DemoSignInError.ExistingConnections -> R.string.demo_sign_in_error_connections
                        DemoSignInError.Failed -> R.string.demo_sign_in_error_failed
                    }), color = MaterialTheme.colorScheme.error)
                }
                if (state.busy) CircularProgressIndicator()
            }
        },
        confirmButton = { TextButton(onClick = onSubmit, enabled = state.canSubmit) {
            Text(stringResource(R.string.demo_sign_in_submit))
        } },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !state.busy) {
            Text(stringResource(R.string.demo_sign_in_cancel))
        } },
    )
}

@Preview
@Composable
private fun DemoSignInPreview() {
    AgentocTheme { DemoSignInDialog(DemoSignInUiState(open = true), {}, {}, {}, {}) }
}

@Preview
@Composable
private fun DemoSignInErrorPreview() {
    AgentocTheme { DemoSignInDialog(DemoSignInUiState(open = true, error = DemoSignInError.Credentials), {}, {}, {}, {}) }
}

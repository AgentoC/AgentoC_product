package com.andysagent.agentoc.feature.workbench

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import com.andysagent.agentoc.core.designsystem.AgentoButton
import com.andysagent.agentoc.core.designsystem.AgentoDialog
import com.andysagent.agentoc.core.designsystem.AgentocSpacing

private const val COMPUTER_RELEASES_URL = "https://www.agentoncloud.com/download.html"

/** Shared by every scanner entry, including first run and additional computers. */
@Composable
fun PairingScanGuideDialog(onScan: () -> Unit, onDismiss: () -> Unit) {
    val clipboard = LocalClipboardManager.current
    val uriHandler = LocalUriHandler.current
    AgentoDialog(
        title = stringResource(R.string.pairing_setup_guide_title),
        confirmLabel = stringResource(R.string.pairing_setup_guide_scan),
        dismissLabel = stringResource(R.string.pairing_cancel),
        onConfirm = onScan,
        onDismiss = onDismiss,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
            Text(stringResource(R.string.pairing_setup_guide_install), style = MaterialTheme.typography.bodyMedium)
            SelectionContainer { Text(COMPUTER_RELEASES_URL, style = MaterialTheme.typography.bodySmall) }
            AgentoButton(stringResource(R.string.pairing_setup_guide_open),
                { runCatching { uriHandler.openUri(COMPUTER_RELEASES_URL) } }, secondary = true)
            AgentoButton(stringResource(R.string.pairing_setup_guide_copy),
                { clipboard.setText(AnnotatedString(COMPUTER_RELEASES_URL)) }, secondary = true)
            Text(stringResource(R.string.pairing_setup_guide_desktop), style = MaterialTheme.typography.bodyMedium)
            Text(stringResource(R.string.pairing_setup_guide_scan_help), style = MaterialTheme.typography.bodyMedium)
        }
    }
}

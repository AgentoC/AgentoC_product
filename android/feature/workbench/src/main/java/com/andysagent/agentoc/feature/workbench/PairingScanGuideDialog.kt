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
import com.andysagent.agentoc.core.designsystem.AgentoDialogActionLayout
import com.andysagent.agentoc.core.designsystem.AgentocSpacing

private const val COMPUTER_RELEASES_URL = "https://www.agentoncloud.com/download.html"

/** Shared by every scanner entry, including first run and additional computers. */
@Composable
fun PairingScanGuideDialog(onScan: () -> Unit, onDismiss: () -> Unit) {
    val clipboard = LocalClipboardManager.current
    val uriHandler = LocalUriHandler.current
    // Resolve before entering the Dialog window: its platform context can use
    // the phone locale instead of the language selected inside AgentoC.
    val title = stringResource(R.string.pairing_setup_guide_title)
    val scan = stringResource(R.string.pairing_setup_guide_scan)
    val cancel = stringResource(R.string.pairing_cancel)
    val install = stringResource(R.string.pairing_setup_guide_install)
    val open = stringResource(R.string.pairing_setup_guide_open)
    val copy = stringResource(R.string.pairing_setup_guide_copy)
    val desktop = stringResource(R.string.pairing_setup_guide_desktop)
    val scanHelp = stringResource(R.string.pairing_setup_guide_scan_help)
    AgentoDialog(
        title = title,
        confirmLabel = scan,
        dismissLabel = cancel,
        onConfirm = onScan,
        onDismiss = onDismiss,
        actionLayout = AgentoDialogActionLayout.PrimaryWithTextDismiss,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
            Text(install, style = MaterialTheme.typography.bodyMedium)
            SelectionContainer { Text(COMPUTER_RELEASES_URL, style = MaterialTheme.typography.bodySmall) }
            AgentoButton(open,
                { runCatching { uriHandler.openUri(COMPUTER_RELEASES_URL) } }, secondary = true)
            AgentoButton(copy,
                { clipboard.setText(AnnotatedString(COMPUTER_RELEASES_URL)) }, secondary = true)
            Text(desktop, style = MaterialTheme.typography.bodyMedium)
            Text(scanHelp, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

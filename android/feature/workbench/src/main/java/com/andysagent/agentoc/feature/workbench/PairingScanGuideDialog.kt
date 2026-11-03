package com.andysagent.agentoc.feature.workbench

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.agentoc.core.designsystem.AgentoDialog
import com.andysagent.agentoc.core.designsystem.AgentoDialogActionLayout
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors

private const val COMPUTER_RELEASES_URL = "https://www.agentoncloud.com/download.html"

/** Shared by every scanner entry, including first run and additional computers. */
@Composable
fun PairingScanGuideDialog(onScan: () -> Unit, onDismiss: () -> Unit) {
    val clipboard = LocalClipboardManager.current
    val uriHandler = LocalUriHandler.current
    // Resolve before entering the dialog window so the selected app language is retained.
    val title = stringResource(R.string.pairing_setup_guide_title)
    val scan = stringResource(R.string.pairing_setup_guide_scan)
    val cancel = stringResource(R.string.pairing_cancel)
    val install = stringResource(R.string.pairing_setup_guide_install)
    val open = stringResource(R.string.pairing_setup_guide_open)
    val copy = stringResource(R.string.pairing_setup_guide_copy)
    val desktop = stringResource(R.string.pairing_setup_guide_desktop)
    val scanHelp = stringResource(R.string.pairing_setup_guide_scan_help)
    val colors = LocalAgentocColors.current
    AgentoDialog(
        title = title,
        confirmLabel = scan,
        dismissLabel = cancel,
        onConfirm = onScan,
        onDismiss = onDismiss,
        actionLayout = AgentoDialogActionLayout.PrimaryWithTextDismiss,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
            PairingGuideStep(number = "1", text = install) {
                Column(
                    modifier = Modifier.fillMaxWidth()
                        .padding(top = 10.dp)
                        .background(colors.primaryContent.copy(alpha = 0.045f), RoundedCornerShape(14.dp))
                        .padding(start = 12.dp, top = 4.dp, end = 4.dp, bottom = 4.dp),
                ) {
                    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(COMPUTER_RELEASES_URL, modifier = Modifier.weight(1f),
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.secondaryContent, lineHeight = 17.sp)
                        IconButton(onClick = { clipboard.setText(AnnotatedString(COMPUTER_RELEASES_URL)) }) {
                            Icon(Icons.Outlined.ContentCopy, contentDescription = copy,
                                modifier = Modifier.size(19.dp), tint = colors.secondaryContent)
                        }
                    }
                    TextButton(onClick = { runCatching { uriHandler.openUri(COMPUTER_RELEASES_URL) } }) {
                        Text(open, style = MaterialTheme.typography.labelLarge, color = colors.actionPrimary)
                        Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = null,
                            modifier = Modifier.padding(start = 6.dp).size(18.dp), tint = colors.actionPrimary)
                    }
                }
            }
            PairingGuideStep(number = "2", text = desktop)
            PairingGuideStep(number = "3", text = scanHelp)
        }
    }
}

@Composable
private fun PairingGuideStep(number: String, text: String, content: @Composable () -> Unit = {}) {
    val colors = LocalAgentocColors.current
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
        Box(
            modifier = Modifier.size(26.dp).background(colors.actionPrimary.copy(alpha = 0.10f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(number, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
                color = colors.actionPrimary)
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(text, style = MaterialTheme.typography.bodyMedium.copy(lineHeight = 22.sp),
                color = colors.primaryContent)
            content()
        }
    }
}

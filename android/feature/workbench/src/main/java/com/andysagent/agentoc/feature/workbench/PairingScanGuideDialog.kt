package com.andysagent.agentoc.feature.workbench

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import com.andysagent.agentoc.core.designsystem.*

private const val COMPUTER_RELEASES_URL = "https://www.agentoncloud.com/download.html"

/** One action per step; account and temporary-access details stay contextual. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PairingScanGuideDialog(onScan: () -> Unit, onDismiss: () -> Unit) {
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val colors = LocalAgentocColors.current
    var step by rememberSaveable { mutableIntStateOf(0) }
    var temporary by rememberSaveable { mutableStateOf(false) }
    var feedback by rememberSaveable { mutableStateOf<Int?>(null) }
    val stepTitle = stringResource(when (step) {
        0 -> R.string.journey_install_step
        1 -> R.string.journey_code_step
        else -> R.string.journey_scan_step
    })
    val progress = stringResource(R.string.journey_step_count, step + 1, 3)
    AgentoDialog(
        title = stepTitle,
        icon = { Text("${step + 1}", style = MaterialTheme.typography.headlineSmall, color = colors.actionPrimary) },
        modifier = Modifier.testTag("computer-setup-guide"),
        confirmLabel = stringResource(when (step) {
            0 -> R.string.journey_installed
            1 -> R.string.journey_code_ready
            else -> R.string.pairing_setup_guide_scan
        }),
        confirmModifier = Modifier.testTag("computer-setup-next"),
        dismissLabel = stringResource(if (step == 0) R.string.pairing_cancel else R.string.journey_previous),
        onConfirm = { if (step == 2) onScan() else { step++; feedback = null } },
        onDismiss = { if (step == 0) onDismiss() else { step--; feedback = null } },
        onDismissRequest = { if (step == 0) onDismiss() else { step--; feedback = null } },
        actionLayout = AgentoDialogActionLayout.PrimaryWithTextDismiss,
        opaqueFallback = true,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(24.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier.fillMaxWidth().testTag("computer-setup-step")
                    .semantics { contentDescription = progress; liveRegion = LiveRegionMode.Polite }) {
                repeat(3) { index ->
                    Box(Modifier.weight(1f).height(4.dp).background(
                        if (index <= step) colors.actionPrimary else colors.subtleOutline, AgentoShapes.Pill))
                }
            }
            when (step) {
                0 -> {
                    Text(stringResource(if (feedback == R.string.journey_link_failed) R.string.journey_link_failed else R.string.journey_handoff_hint),
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        AgentoButton(text = stringResource(R.string.journey_share_link), secondary = true,
                            secondaryContainerColor = colors.canvas.copy(alpha = 0f), labelMaxLines = 2,
                            contentPadding = PaddingValues(horizontal = 4.dp),
                            leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Share, null, Modifier.size(24.dp)) },
                            onClick = {
                            feedback = null
                            runCatching {
                                context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                                    type = "text/plain"
                                    putExtra(Intent.EXTRA_TEXT, COMPUTER_RELEASES_URL)
                                }, context.getString(R.string.journey_share_link)))
                            }.onFailure { feedback = R.string.journey_link_failed }
                        })
                        AgentoButton(text = stringResource(if (feedback == R.string.journey_link_copied) R.string.journey_link_copied else R.string.pairing_setup_guide_copy), secondary = true,
                            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                            secondaryContainerColor = colors.canvas.copy(alpha = 0f), labelMaxLines = 2,
                            contentPadding = PaddingValues(horizontal = 4.dp),
                            leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Copy, null, Modifier.size(24.dp)) },
                            onClick = {
                            clipboard.setText(AnnotatedString(COMPUTER_RELEASES_URL))
                            feedback = R.string.journey_link_copied
                        })
                    }
                }
                1 -> {
                    Column(Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(stringResource(R.string.journey_choose_connection),
                            style = MaterialTheme.typography.titleSmall,
                            modifier = Modifier.semantics { heading() })
                        AgentoRadioOption(
                            title = stringResource(R.string.journey_long_term),
                            description = stringResource(R.string.journey_long_term_summary),
                            selected = !temporary,
                            modifier = Modifier.testTag("setup-long-term"),
                            onClick = { temporary = false },
                        )
                        AgentoRadioOption(
                            title = stringResource(R.string.journey_temporary),
                            description = stringResource(R.string.journey_temporary_summary),
                            selected = temporary,
                            modifier = Modifier.testTag("setup-temporary"),
                            onClick = { temporary = true },
                        )
                    }
                    Text(stringResource(if (temporary) R.string.journey_temporary_instructions else R.string.journey_account_instructions),
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.testTag("computer-setup-method").semantics { liveRegion = LiveRegionMode.Polite })
                }
                else -> Text(stringResource(R.string.journey_scan_hint), style = MaterialTheme.typography.bodyLarge)
            }
        }
    }
}

package com.andysagent.agentoc.feature.workbench

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
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
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.agentoc.core.designsystem.*

private const val COMPUTER_RELEASES_URL = "https://www.agentoncloud.com/download.html"

/** One action per step; account and temporary-access details stay contextual. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PairingScanGuideDialog(onScan: () -> Unit, onDismiss: () -> Unit) {
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val colors = LocalAgentocColors.current
    val instructionStyle = MaterialTheme.typography.bodyMedium.copy(
        fontSize = 15.sp, lineHeight = 24.sp, lineBreak = LineBreak.Heading,
    )
    var step by rememberSaveable { mutableIntStateOf(0) }
    var feedback by rememberSaveable { mutableStateOf<Int?>(null) }
    val stepTitle = stringResource(when (step) {
        0 -> R.string.journey_install_step
        1 -> R.string.journey_code_step
        else -> R.string.journey_scan_step
    })
    val progress = stringResource(R.string.journey_step_count, step + 1, 3)
    AgentoDialog(
        title = stepTitle,
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
        textureAlpha = 0.2f,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier.width(72.dp).testTag("computer-setup-step")
                    .semantics { contentDescription = progress; liveRegion = LiveRegionMode.Polite }) {
                repeat(3) { index ->
                    Box(Modifier.weight(1f).height(3.dp).background(
                        if (index <= step) colors.accentPrimary else colors.subtleOutline, AgentoShapes.Pill))
                }
            }
            when (step) {
                0 -> {
                    Text(stringResource(if (feedback == R.string.journey_link_failed) R.string.journey_link_failed else R.string.journey_handoff_hint),
                        style = instructionStyle, color = colors.secondaryContent,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        OnboardingTextAction(text = stringResource(R.string.journey_share_link),
                            leadingIcon = AgentoWebGlyph.Share,
                            onClick = {
                            feedback = null
                            runCatching {
                                context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                                    type = "text/plain"
                                    putExtra(Intent.EXTRA_TEXT, COMPUTER_RELEASES_URL)
                                }, context.getString(R.string.journey_share_link)))
                            }.onFailure { feedback = R.string.journey_link_failed }
                        })
                        OnboardingTextAction(text = stringResource(if (feedback == R.string.journey_link_copied) R.string.journey_link_copied else R.string.pairing_setup_guide_copy),
                            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                            leadingIcon = AgentoWebGlyph.Copy,
                            onClick = {
                            clipboard.setText(AnnotatedString(COMPUTER_RELEASES_URL))
                            feedback = R.string.journey_link_copied
                        })
                    }
                }
                1 -> Text(
                    emphasizedMenuNames(stringResource(R.string.journey_account_instructions)),
                    style = instructionStyle, color = colors.secondaryContent,
                    modifier = Modifier.testTag("computer-setup-instructions"),
                )
                else -> Text(stringResource(R.string.journey_scan_hint), style = instructionStyle, color = colors.secondaryContent)
            }
        }
    }
}

/** Emphasize the existing localized menu labels without adding another visual layer. */
@Composable
private fun emphasizedMenuNames(instructions: String): AnnotatedString {
    val colors = LocalAgentocColors.current
    return buildAnnotatedString {
        append(instructions)
        Regex("「[^」]+」|“[^”]+”|«[^»]+»").findAll(instructions).forEach {
            addStyle(SpanStyle(color = colors.primaryContent, fontWeight = FontWeight.Medium),
                it.range.first, it.range.last + 1)
        }
    }
}

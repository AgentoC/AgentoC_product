package com.andysagent.agentoc.feature.workbench

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.HorizontalDivider
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.andysagent.agentoc.core.designsystem.*

@Composable
internal fun ProviderInstanceSelector(state: WebParityUiState, onEvent: (WebParityEvent) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val selected = state.providerInstances.firstOrNull { it.instance.id == state.providerTargetId }
    val canSwitch = !state.actionInProgress && state.providerOAuthJob?.terminal != false
    val colors = LocalAgentocColors.current
    Box(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp)) {
        Row(Modifier.widthIn(max = 280.dp).heightIn(min = 48.dp).clip(CircleShape)
            .background(colors.surfaceLow).border(1.dp, colors.primaryContent.copy(alpha = 0.10f), CircleShape)
            .clickable(enabled = canSwitch, role = Role.Button) { expanded = true }
            .testTag("provider-instance-selector").padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            AgentoWebIcon(AgentoWebGlyph.Monitor, null, Modifier.size(18.dp), tint = colors.accentPrimary)
            Text(selected?.instance?.label ?: stringResource(R.string.pi_all), Modifier.weight(1f, fill = false),
                style = MaterialTheme.typography.labelLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
            AgentoWebIcon(AgentoWebGlyph.ChevronDown, null, Modifier.size(16.dp), tint = colors.secondaryContent)
        }
        AgentoDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, opaqueFallback = true) {
            DropdownMenuItem(text = { Text(stringResource(R.string.pi_all)) },
                onClick = { expanded = false; onEvent(WebParityEvent.SelectProviderInstance(null)) },
                modifier = Modifier.testTag("provider-instance-all"))
            state.providerInstances.forEach { target ->
                DropdownMenuItem(text = { Column {
                    Text(target.instance.label)
                    Text(stringResource(when { target.loading -> R.string.pi_loading
                        target.available -> R.string.pi_connected; else -> R.string.pi_offline_short }),
                        style = MaterialTheme.typography.bodySmall)
                } }, onClick = { expanded = false; onEvent(WebParityEvent.SelectProviderInstance(target.instance.id)) },
                    modifier = Modifier.testTag("provider-instance-${target.instance.id}"))
            }
        }
    }
}

@Composable
internal fun AccountProvidersOverview(state: WebParityUiState, onEvent: (WebParityEvent) -> Unit) {
    val restricted = LocalRestrictedDemoEnvironment.current
    val groups = remember(state.providerInstances, restricted) { accountProviderGroups(state.providerInstances, restricted) }
    val colors = LocalAgentocColors.current
    LazyColumn(contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.testTag("provider-account-overview")) {
        item {
            Text(stringResource(R.string.pi_overview_hint), style = MaterialTheme.typography.bodySmall,
                color = colors.secondaryContent)
        }
        if (state.providerInstances.isEmpty() && !state.refreshing) item { Text(stringResource(R.string.pi_no_instances)) }
        val unconfirmed = state.providerInstances.filter { !it.available || it.loading }
        if (unconfirmed.isNotEmpty()) item {
            ManagementHint(stringResource(R.string.pi_unconfirmed, unconfirmed.joinToString("、") { it.instance.label }), AgentoWebGlyph.Clock)
        }
        if (groups.isEmpty() && !state.refreshing && state.providerInstances.any { it.available }) item {
            Text(stringResource(R.string.pi_empty))
        }
        listOf(false, true).forEach { local ->
          val section = groups.filter { it.provider.machineLocal == local }
          if (section.isNotEmpty()) item(key = "section-$local") {
              Text(stringResource(if (local) R.string.pi_local else R.string.pi_shared),
                  Modifier.padding(top = 12.dp, start = 4.dp), style = MaterialTheme.typography.labelLarge,
                  color = colors.secondaryContent)
          }
          items(section, key = { it.key }) { group ->
            if (local) {
                val copy = group.copies.first()
                val credentialState = stringResource(if (copy.provider.ready) R.string.pi_credentials_saved else R.string.sp_credentials_missing)
                ManagementCard(Modifier.fillMaxWidth().testTag("provider-group-${group.key}")) {
                    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(12.dp))
                        .clickable(role = Role.Button) { onEvent(WebParityEvent.SelectProviderInstance(copy.instance.id)) }
                        .semantics { stateDescription = credentialState }
                        .testTag("provider-manage-${copy.instance.id}-${copy.provider.id}"),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        ManagementIdentity(AgentoWebGlyph.Shield)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(group.provider.name, style = MaterialTheme.typography.titleSmall)
                            Text(copy.instance.label, style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
                            if (!copy.provider.ready) Text(credentialState, style = MaterialTheme.typography.labelSmall, color = colors.error)
                        }
                        if (copy.provider.ready) AgentoWebIcon(AgentoWebGlyph.Check, null, Modifier.size(16.dp), tint = colors.success)
                        AgentoWebIcon(AgentoWebGlyph.ChevronRight, null, Modifier.size(18.dp), tint = colors.secondaryContent)
                    }
                }
            } else ManagementCard(Modifier.fillMaxWidth().testTag("provider-group-${group.key}")) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        ManagementIdentity(if (local) AgentoWebGlyph.Shield else AgentoWebGlyph.Agent)
                        Text(group.provider.name, style = MaterialTheme.typography.titleMedium,
                            modifier = Modifier.weight(1f))
                    }
                    if (!group.provider.machineLocal && group.copies.size > 1) ManagementHint(stringResource(
                        when {
                            group.copies.any { copy -> state.providerInstances.any { it.instance.id == copy.instance.id && it.loading } } -> R.string.pi_compare_pending
                            group.configurationMatches -> R.string.pi_matching
                            group.configurationDiffers -> R.string.pi_different
                            else -> R.string.pi_compare_pending
                        }, group.copies.size), if (group.configurationMatches) AgentoWebGlyph.Check else AgentoWebGlyph.Info)
                    HorizontalDivider(color = colors.primaryContent.copy(alpha = 0.07f))
                    group.copies.forEach { copy ->
                        val credentialState = stringResource(if (copy.provider.ready) R.string.pi_credentials_saved else R.string.sp_credentials_missing)
                        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(12.dp))
                            .clickable(role = Role.Button) { onEvent(WebParityEvent.SelectProviderInstance(copy.instance.id)) }
                            .semantics { stateDescription = credentialState }
                            .testTag("provider-manage-${copy.instance.id}-${copy.provider.id}")
                            .padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            AgentoWebIcon(AgentoWebGlyph.Monitor, null, Modifier.size(18.dp), tint = colors.tertiaryContent)
                            Column(Modifier.weight(1f)) {
                                Text(copy.instance.label, style = MaterialTheme.typography.bodyMedium)
                                if (!copy.provider.ready) Text(credentialState,
                                    style = MaterialTheme.typography.labelSmall, color = colors.error)
                            }
                            if (copy.provider.ready) AgentoWebIcon(AgentoWebGlyph.Check, null, Modifier.size(16.dp), tint = colors.success)
                            AgentoWebIcon(AgentoWebGlyph.ChevronRight, null, Modifier.size(18.dp), tint = colors.secondaryContent)
                        }
                    }
                    if (!group.provider.machineLocal && group.provider.syncId.isBlank()) {
                        Text(stringResource(R.string.pi_legacy), style = MaterialTheme.typography.bodySmall,
                            color = LocalAgentocColors.current.secondaryContent)
                    }
                    if (!group.provider.machineLocal && group.provider.syncId.isNotBlank()) {
                        val absent = state.providerInstances.filter { target -> target.available && !target.loading &&
                            target.snapshot.providers.all { it.machineLocal || it.syncId.isNotBlank() } &&
                            group.copies.none { it.instance.id == target.instance.id } }
                        if (absent.isNotEmpty()) Text(stringResource(R.string.pi_not_observed, absent.joinToString("、") { it.instance.label }),
                            style = MaterialTheme.typography.bodySmall, color = LocalAgentocColors.current.secondaryContent)
                    }
            }
          }
        }
    }
}

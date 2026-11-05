package com.andysagent.agentoc.feature.workbench

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.andysagent.agentoc.core.designsystem.*

@Composable
internal fun ProviderInstanceSelector(state: WebParityUiState, onEvent: (WebParityEvent) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val selected = state.providerInstances.firstOrNull { it.instance.id == state.providerTargetId }
    val canSwitch = !state.actionInProgress && state.providerOAuthJob?.terminal != false
    Box(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp)) {
        AgentoButton(selected?.instance?.label ?: stringResource(R.string.pi_all), { expanded = true },
            secondary = true, enabled = canSwitch, modifier = Modifier.testTag("provider-instance-selector"),
            labelMaxLines = 2, leadingIcon = { AgentoWebIcon(AgentoWebGlyph.ChevronDown, null) })
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
    LazyColumn(contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp), modifier = Modifier.testTag("provider-account-overview")) {
        item {
            Text(stringResource(R.string.pi_overview_hint), style = MaterialTheme.typography.bodyMedium,
                color = LocalAgentocColors.current.secondaryContent)
        }
        if (state.providerInstances.isEmpty() && !state.refreshing) item { Text(stringResource(R.string.pi_no_instances)) }
        val unconfirmed = state.providerInstances.filter { !it.available || it.loading }
        if (unconfirmed.isNotEmpty()) item {
            Text(stringResource(R.string.pi_unconfirmed, unconfirmed.joinToString("、") { it.instance.label }),
                style = MaterialTheme.typography.bodySmall, color = LocalAgentocColors.current.secondaryContent)
        }
        if (groups.isEmpty() && !state.refreshing && state.providerInstances.any { it.available }) item {
            Text(stringResource(R.string.pi_empty))
        }
        items(groups, key = { it.key }) { group ->
            SettingsContentCard(Modifier.fillMaxWidth().testTag("provider-group-${group.key}")) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(group.provider.name, style = MaterialTheme.typography.titleMedium)
                    Text(stringResource(if (group.provider.machineLocal) R.string.pi_local else R.string.pi_shared),
                        color = LocalAgentocColors.current.secondaryContent, style = MaterialTheme.typography.labelMedium)
                    if (!group.provider.machineLocal && group.copies.size > 1) Text(stringResource(
                        when {
                            group.copies.any { copy -> state.providerInstances.any { it.instance.id == copy.instance.id && it.loading } } -> R.string.pi_compare_pending
                            group.configurationMatches -> R.string.pi_matching
                            group.configurationDiffers -> R.string.pi_different
                            else -> R.string.pi_compare_pending
                        }, group.copies.size),
                        style = MaterialTheme.typography.bodySmall)
                    group.copies.forEach { copy ->
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Column(Modifier.weight(1f)) {
                                Text(copy.instance.label, style = MaterialTheme.typography.bodyMedium)
                                Text(stringResource(if (copy.provider.ready) R.string.pi_credentials_saved else R.string.sp_credentials_missing),
                                    style = MaterialTheme.typography.bodySmall, color = LocalAgentocColors.current.secondaryContent)
                            }
                            OnboardingTextAction(stringResource(R.string.pi_manage), {
                                onEvent(WebParityEvent.SelectProviderInstance(copy.instance.id))
                            }, modifier = Modifier.testTag("provider-manage-${copy.instance.id}-${copy.provider.id}"))
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
        item {
            Text(stringResource(R.string.pi_choose_hint), style = MaterialTheme.typography.bodySmall,
                color = LocalAgentocColors.current.secondaryContent)
        }
    }
}

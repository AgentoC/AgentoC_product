package com.andysagent.agentoc.feature.workbench

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.andysagent.agentoc.core.timeline.RunActionUiState

/** Provider-written prose remains verbatim; only our own templates are localized. */
@Composable
internal fun presentRunAction(action: RunActionUiState): String {
    val subject = presentActionSubject(action.presentationSubject.ifBlank { if (action.presentationVerb == "execute") "command" else "" })
    return when (action.presentationVerb) {
        "read" -> stringResource(R.string.run_action_read, subject)
        "list" -> stringResource(R.string.run_action_list, subject)
        "search" -> stringResource(R.string.run_action_search, subject)
        "inspect" -> stringResource(R.string.run_action_inspect, subject)
        "edit" -> stringResource(R.string.run_action_edit, subject)
        "execute" -> stringResource(R.string.run_action_execute, subject)
        "delegate" -> stringResource(R.string.run_action_delegate, subject)
        "tool" -> stringResource(R.string.run_action_tool, subject)
        "working" -> stringResource(R.string.run_action_working)
        "thinking" -> stringResource(R.string.run_action_thinking)
        "planning" -> stringResource(R.string.run_action_planning)
        "starting" -> stringResource(R.string.run_action_starting)
        "approval" -> stringResource(R.string.run_action_approval)
        else -> action.sentence
    }
}

@Composable
internal fun presentCompletedAction(action: RunActionUiState): String {
    val subject = presentActionSubject(action.presentationSubject.ifBlank { if (action.presentationVerb == "execute") "command" else "" })
    return when (action.presentationVerb) {
        "read" -> stringResource(R.string.run_action_done_read, subject)
        "list" -> stringResource(R.string.run_action_done_list, subject)
        "search" -> stringResource(R.string.run_action_done_search, subject)
        "inspect" -> stringResource(R.string.run_action_done_inspect, subject)
        "edit" -> stringResource(R.string.run_action_done_edit, subject)
        "execute" -> stringResource(R.string.run_action_done_execute, subject)
        "delegate" -> stringResource(R.string.run_action_done_delegate, subject)
        "tool" -> stringResource(R.string.run_action_done_tool, subject)
        else -> stringResource(R.string.run_action_done_generic)
    }
}

@Composable
private fun presentActionSubject(subject: String): String = when (subject.lowercase()) {
    "command" -> stringResource(R.string.run_subject_command)
    "workspace" -> stringResource(R.string.run_subject_workspace)
    "file" -> stringResource(R.string.run_subject_file)
    "the task" -> stringResource(R.string.run_subject_task)
    "workspace changes" -> stringResource(R.string.run_subject_changes)
    else -> subject
}

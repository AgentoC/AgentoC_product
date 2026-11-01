package com.andysagent.agentoc.feature.workbench

import com.andysagent.agentoc.core.model.RemoteTarget
import com.andysagent.agentoc.core.model.RemoteTargetAccessState

/** Revoked computers remain visible in device management, but cannot be selected as a workspace. */
internal fun projectComputerChoices(targets: List<RemoteTarget>): List<RemoteTarget> =
    targets.filter { it.accessState != RemoteTargetAccessState.Revoked }

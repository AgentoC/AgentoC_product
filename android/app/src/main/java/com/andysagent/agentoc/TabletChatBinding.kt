package com.andysagent.agentoc

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.andysagent.agentoc.core.domain.SessionRepository
import com.andysagent.agentoc.core.domain.SwitchingSessionRepository
import com.andysagent.agentoc.core.network.AgentoCTransport
import com.andysagent.agentoc.core.network.SwitchingAgentoCTransport
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The detail pane owns its computer independently of the foreground list. */
internal class TabletChatBinding : ViewModel() {
    val sessions = SwitchingSessionRepository(viewModelScope)
    val transport = SwitchingAgentoCTransport(viewModelScope, closeDelegates = false)
    private val mutableTargetId = MutableStateFlow<String?>(null)
    val targetId = mutableTargetId.asStateFlow()

    suspend fun bind(repository: SessionRepository?, targetId: String?, source: AgentoCTransport?) {
        transport.switchTo(source)
        sessions.switchTo(repository)
        mutableTargetId.value = targetId
    }
}

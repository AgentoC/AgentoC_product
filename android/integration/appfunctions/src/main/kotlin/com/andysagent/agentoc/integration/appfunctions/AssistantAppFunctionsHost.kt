package com.andysagent.agentoc.integration.appfunctions

import com.andysagent.agentoc.core.appapi.AssistantTaskBridge

/** Plain host seam; loading the Application on older Android does not load a platform service. */
interface AssistantAppFunctionsHost {
    val assistantAppFunctions: AssistantTaskBridge
}

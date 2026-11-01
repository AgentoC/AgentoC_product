package com.andysagent.agentoc.feature.workbench

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class AssistantDisplayTextTest {
    @Test fun metadataIsHiddenAtEveryTokenBoundaryAndVisibleReplyIsPreserved() {
        for (tag in listOf("session-labels", "organization-proposal", "collaboration-plan", "result-packet")) {
            val block = "<agentoc-$tag>{\"title\":\"Internal\"}</agentoc-$tag>"
            for (length in 0..block.length) {
                assertEquals("Hello", displayAgentMessageText("Hello\n" + block.take(length)))
            }
            assertEquals("Hello\n\nMore", displayAgentMessageText("Hello\n$block\nMore"))
        }
    }

    @Test fun malformedMultipleAndCaseInsensitiveEnvelopesStayInternal() {
        assertEquals("Reply", displayAgentMessageText("Reply<AGENTOC-SESSION-LABELS>{\"partial\":"))
        assertEquals("Reply", displayAgentMessageText("Reply<agentoc-session-labels>{}</agentoc-session-labels><agentoc-result-packet>{}</agentoc-result-packet>"))
        assertFalse(displayAgentMessageText("<agentoc-session-labels>{}</agentoc-session-labels>").isNotBlank())
    }

    @Test fun normalMarkdownAndMathArePreserved() {
        val normal = "**Hello**\n\n```kotlin\nif (x < 3) println(x)\n```"
        assertEquals(normal, displayAgentMessageText(normal))
    }
}

package com.andysagent.agentoc.core.appapi

import kotlin.test.*

class SessionNavigationTest {
    @Test fun roundTripKeepsExactComputerAndSession() {
        val request = SessionNavigationRequest("s-1", "inst_pc-b")
        assertEquals(request, parseSessionNavigationUri(sessionNavigationUri(request)))
    }
    @Test fun legacyTargetMustBeChosenBeforeLinkCanBeProduced() {
        val request = SessionNavigationRequest("s1").validated()
        assertEquals(ApiErrorCode.AMBIGUOUS_TARGET, assertFailsWith<AppApiException> { sessionNavigationUri(request) }.error.code)
    }
    @Test fun rejectsAmbiguousEncodedAndCommandLinks() {
        listOf("agentoc://session/s1", "agentoc://session/s1?instanceId=", "agentoc://session/s1?instanceId=a&instanceId=b",
            "agentoc://session/s1?instanceId=a&autoStart=true", "agentoc://session/s1?instanceId=a#x",
            "agentoc://session/s1/s2?instanceId=a", "agentoc://session/%2e%2e?instanceId=a", "agentoc://session/s1?instanceId=a%2Fb",
            "agentoc://session:42/s1?instanceId=a", "agentoc://user@session/s1?instanceId=a", "https://session/s1?instanceId=a",
            "agentoc://sessionevil/s1?instanceId=a", "agentoc://session/s1?instanceId=a&token=secret").forEach { value ->
            assertEquals(ApiErrorCode.INVALID_ARGUMENT, assertFailsWith<AppApiException>(value) { parseSessionNavigationUri(value) }.error.code)
        }
    }
    @Test fun differentComputersAndJavaHashCollisionSessionsHaveIndependentIdentity() {
        assertEquals("Aa".hashCode(), "BB".hashCode())
        val a = SessionNavigationRequest("Aa", "pc-a")
        assertNotEquals(a.identity(), a.copy(sessionId = "BB").identity())
        assertNotEquals(a.identity(), a.copy(targetInstanceId = "pc-b").identity())
        assertNotEquals(a.identity(), a.copy(targetInstanceId = null).identity())
    }
    @Test fun redeliveryHasStableIdentityAndEventIdIsScopedToTargetAndSession() {
        val a = SessionNavigationRequest("s1", "a", "attention", "question", "evt-1")
        assertEquals(a.identity(), a.copy(kind = "completion", awaitingKey = "").identity())
        assertNotEquals(a.identity(), a.copy(targetInstanceId = "b").identity())
        assertNotEquals(a.identity(), a.copy(sessionId = "s2").identity())
        assertNotEquals(a.identity(), a.copy(eventId = "evt-2").identity())
    }
    @Test fun missingEventUsesKindAndAwaitingKey() {
        val a = SessionNavigationRequest("s1", "a", "attention", "question")
        assertEquals(a.identity(), a.copy().identity())
        assertNotEquals(a.identity(), a.copy(kind = "completion").identity())
        assertNotEquals(a.identity(), a.copy(awaitingKey = "another question").identity())
    }
    @Test fun boundsAndControlCharactersAreRejected() {
        listOf(SessionNavigationRequest("../s"), SessionNavigationRequest("s", ""), SessionNavigationRequest("s".repeat(161)),
            SessionNavigationRequest("s", kind = "x".repeat(65)), SessionNavigationRequest("s", kind = "中".repeat(22)),
            SessionNavigationRequest("s", awaitingKey = "中".repeat(171)),
            SessionNavigationRequest("s", eventId = "x".repeat(257)), SessionNavigationRequest("s", kind = "x\ny")).forEach {
            assertFailsWith<AppApiException> { it.validated() }
        }
    }
}

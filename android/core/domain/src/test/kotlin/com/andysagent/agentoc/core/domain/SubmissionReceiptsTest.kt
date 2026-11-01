package com.andysagent.agentoc.core.domain

import com.andysagent.agentoc.core.protocol.AgentocProtocol
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SubmissionReceiptsTest {
    @Test fun readOnlyLookupDistinguishesAcceptanceFromMissingEvidence() {
        val known = lookupMessageSubmissionReceipt("s", "r", AgentocProtocol.json.parseToJsonElement(
            """{"receiptContractVersion":1,"sessionId":"s","requestId":"r","state":"accepted","queued":true,"runId":null}""",
        ).jsonObject)!!
        assertTrue(known.queued); assertNull(known.runId)
        assertEquals(false, known.duplicate)
        assertNull(lookupMessageSubmissionReceipt("s", "r", AgentocProtocol.json.parseToJsonElement(
            """{"receiptContractVersion":1,"sessionId":"s","requestId":"r","state":"unconfirmed"}""",
        ).jsonObject))
    }

    @Test fun malformedLookupCannotBecomeAcceptance() {
        for (value in listOf(
            """{"receiptContractVersion":1,"sessionId":"other","requestId":"r","state":"accepted","queued":false}""",
            """{"receiptContractVersion":0,"sessionId":"s","requestId":"r","state":"accepted","queued":false}""",
            """{"receiptContractVersion":1,"sessionId":"s","requestId":"r","state":"accepted"}""",
            """{"receiptContractVersion":1,"sessionId":"s","requestId":"r","state":"failed"}""",
        )) {
            kotlin.test.assertFails { lookupMessageSubmissionReceipt("s", "r", AgentocProtocol.json.parseToJsonElement(value).jsonObject) }
        }
    }

    @Test fun queuedAcceptanceMayHaveNoRun() {
        val receipt = messageSubmissionReceipt("s", "r", AgentocProtocol.json.parseToJsonElement(
            """{"requestId":"r","duplicate":false,"queued":true,"run":null}""",
        ).jsonObject)
        assertTrue(receipt.queued)
        assertNull(receipt.runId)
    }

    @Test fun duplicateAcceptanceRetainsRunIdentity() {
        val receipt = messageSubmissionReceipt("s", "r", AgentocProtocol.json.parseToJsonElement(
            """{"requestId":"r","duplicate":true,"queued":false,"run":{"id":"run-1"}}""",
        ).jsonObject)
        assertTrue(receipt.duplicate)
        assertEquals("run-1", receipt.runId)
        assertEquals("s", receipt.sessionId)
    }

    @Test fun missingOrMismatchedIdentityCannotBecomeAcceptance() {
        for (value in listOf("{}", """{"requestId":"other"}""")) {
            assertFailsWith<IllegalArgumentException> {
                messageSubmissionReceipt("s", "r", AgentocProtocol.json.parseToJsonElement(value).jsonObject)
            }
        }
    }
}

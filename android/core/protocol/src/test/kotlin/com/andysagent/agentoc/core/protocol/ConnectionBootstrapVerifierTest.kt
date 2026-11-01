package com.andysagent.agentoc.core.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class ConnectionBootstrapVerifierTest {
    @Test
    fun `verifies Node signed contract after JSON transport round trip`() {
        val fixture = javaClass.getResource("/fixtures/connection-bootstrap-signed.json")!!.readText()
        val envelope = AgentocProtocol.json.parseToJsonElement(fixture).jsonObject
        val rawContract = envelope["contract"]!!.jsonObject.toString()
        val publicKey = ConnectionBootstrapPublicKeyDto(
            algorithm = "ed25519",
            keyId = "fixture-key",
            publicKeyPem = envelope["publicKeyPem"]!!.jsonPrimitive.contentOrNull!!,
        )

        val verified = ConnectionBootstrapVerifier.verify(
            rawContract = rawContract,
            publicKey = publicKey,
            nowMs = 1_788_307_200_000L,
        )

        assertNotNull(verified)
        assertEquals("rli_fixture_001", verified.contract.instanceId)
        assertEquals("rdev_fixture_001", verified.contract.deviceId)
    }
}

package com.andysagent.agentoc.core.auth

import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class WindowsServiceControlApprovalTest {
    private val grant = WindowsServiceControlGrant(1, "key", "broker", 3, "request", "session", "run", "turn", "action",
        "0123456789abcdefghijklmn", "服务 示例 & one", "restart-service", "a".repeat(64), "owner", 1800000000000, 1800000060000)
    private fun bytes(value: WindowsServiceControlGrant = grant, now: Long = grant.issuedMs) =
        WindowsServiceControlApproval.ownerSigningBytes(value, now)

    @Test fun matchesBrokerAndControlPlaneVector() {
        val expected = "e0cb3610783fd33fdc745e5059474811b3dac76415ef91a283cf110df0af9bf1"
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes()).joinToString("") { "%02x".format(it.toInt() and 255) }
        assertTrue(digest == expected)
        assertContentEquals(bytes(), bytes())
    }

    @Test fun signatureIsBoundToOperationAndExpiry() {
        val keys = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val signature = Signature.getInstance("SHA256withECDSA").run { initSign(keys.private); update(bytes()); sign() }
        fun verify(value: WindowsServiceControlGrant) = Signature.getInstance("SHA256withECDSA").run {
            initVerify(keys.public); update(bytes(value)); verify(signature)
        }
        assertTrue(verify(grant))
        assertFalse(verify(grant.copy(serviceName = "另一项服务")))
        assertFalse(verify(grant.copy(action = "stop-service")))
        assertFailsWith<IllegalArgumentException> { bytes(now = grant.expiresMs) }
        assertFailsWith<IllegalArgumentException> { bytes(grant.copy(serviceName = "bad*")) }
        assertFailsWith<IllegalArgumentException> { bytes(grant.copy(serviceName = "bad\uD800")) }
        assertFailsWith<IllegalArgumentException> { bytes(grant.copy(authorization = "policy-auto")) }
    }
}

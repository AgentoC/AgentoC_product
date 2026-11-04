package com.andysagent.agentoc.core.auth

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Opt-in, isolated loopback fixture; it never uses the installed app's identity. */
@RunWith(AndroidJUnit4::class)
class WindowsServiceControlLiveBrokerInstrumentedTest {
    @Test fun androidKeyApprovesTheReviewedBrokerGrant() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val port = InstrumentationRegistry.getArguments().getString("agentocBrokerTestPort")?.toIntOrNull()
        assumeTrue(port != null && port in 1025..65535)
        val identity = AndroidDeviceIdentityStore(instrumentation.targetContext)
        val publicKey = identity.brokerPublicKey()
        val deviceId = BrokerApprovalProtocol.deviceIdForPublicKey(publicKey)
        fun request(method: String, route: String, body: JSONObject? = null): Pair<Int, String> {
            val connection = URL("http://127.0.0.1:$port$route").openConnection() as HttpURLConnection
            connection.requestMethod = method
            connection.connectTimeout = 3_000
            connection.readTimeout = 3_000
            try {
                if (body != null) {
                    connection.doOutput = true
                    connection.setRequestProperty("Content-Type", "application/json")
                    connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
                }
                val status = connection.responseCode
                return status to connection.inputStream.bufferedReader().use { it.readText() }
            } finally { connection.disconnect() }
        }
        val registration = JSONObject().put("deviceId", deviceId).put("publicKey", publicKey)
        assertEquals(200, request("POST", "/register", registration).first)
        val deadline = System.nanoTime() + 80_000_000_000L
        var review: JSONObject? = null
        while (System.nanoTime() < deadline && review == null) {
            val response = request("GET", "/review")
            if (response.first == 200) review = JSONObject(response.second) else {
                assertEquals(202, response.first)
                Thread.sleep(100)
            }
        }
        val result = requireNotNull(review) { "Timed out waiting for isolated broker review" }
        val g = result.getJSONObject("grant")
        val grant = WindowsServiceControlGrant(
            g.getLong("version"), g.getString("keyId"), g.getString("brokerInstallationId"), g.getLong("policyGeneration"),
            g.getString("requestId"), g.getString("sessionId"), g.getString("runId"), g.getString("turnId"),
            g.getString("actionId"), g.getString("nonce"), g.getString("serviceName"), g.getString("action"),
            g.getString("definitionHash"), g.getString("authorization"), g.getLong("issuedMs"), g.getLong("expiresMs"),
        )
        val brokerKey = result.getString("brokerPublicKey")
        assertTrue(WindowsServiceControlApproval.verifyBrokerReview(
            grant, brokerKey, result.getString("brokerSignature"), BrokerApprovalProtocol.fingerprint(brokerKey),
        ))
        assertEquals("start-service", grant.action)
        assertTrue(grant.serviceName.startsWith("AgentoC-QA-Service-"))
        val signature = identity.signBrokerBytes(WindowsServiceControlApproval.ownerSigningBytes(grant))
        assertEquals(200, request("POST", "/decision", JSONObject().put("signature", signature)).first)
    }
}

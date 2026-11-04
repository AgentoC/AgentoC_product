package com.andysagent.agentoc.core.auth

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream

/** An exact broker operation displayed to and approved by the device owner. */
data class WindowsServiceControlGrant(
    val version: Long,
    val keyId: String,
    val brokerInstallationId: String,
    val policyGeneration: Long,
    val requestId: String,
    val sessionId: String,
    val runId: String,
    val turnId: String,
    val actionId: String,
    val nonce: String,
    val serviceName: String,
    val action: String,
    val definitionHash: String,
    val authorization: String,
    val issuedMs: Long,
    val expiresMs: Long,
)

object WindowsServiceControlApproval {
    private const val OWNER_DOMAIN = "AgentoC Windows service owner approval v1\u0000"
    private const val GRANT_DOMAIN = "AgentoC Windows service control v1\u0000"
    private val id = Regex("^[A-Za-z0-9._:-]{1,128}$")
    private val nonce = Regex("^[A-Za-z0-9_-]{24,128}$")
    private val digest = Regex("^[a-f0-9]{64}$")

    /** Validate the short-lived grant before handing bytes to the device key. */
    fun ownerSigningBytes(grant: WindowsServiceControlGrant, nowMs: Long = System.currentTimeMillis()): ByteArray {
        require(grant.version == 1L && grant.policyGeneration > 0)
        require(listOf(grant.keyId, grant.brokerInstallationId, grant.requestId, grant.sessionId,
            grant.runId, grant.turnId, grant.actionId).all(id::matches))
        require(nonce.matches(grant.nonce))
        require(grant.serviceName.isNotEmpty() && grant.serviceName == grant.serviceName.trim())
        require(grant.serviceName.toByteArray(Charsets.UTF_8).toString(Charsets.UTF_8) == grant.serviceName)
        require(grant.serviceName.codePointCount(0, grant.serviceName.length) <= 256)
        require(grant.serviceName.none { it == '\\' || it == '/' || it == '*' || it == '?' || Character.isISOControl(it) })
        require(grant.action in setOf("start-service", "stop-service", "restart-service"))
        require(digest.matches(grant.definitionHash) && grant.authorization == "owner")
        require(grant.issuedMs > 0 && grant.expiresMs > grant.issuedMs && grant.expiresMs - grant.issuedMs <= 60_000)
        require(nowMs >= grant.issuedMs && nowMs < grant.expiresMs)
        return ByteArrayOutputStream().use { output ->
            DataOutputStream(output).use { data ->
                data.write(OWNER_DOMAIN.toByteArray(Charsets.UTF_8))
                data.write(GRANT_DOMAIN.toByteArray(Charsets.UTF_8))
                fun text(value: String) { val bytes = value.toByteArray(Charsets.UTF_8); data.writeInt(bytes.size); data.write(bytes) }
                data.writeLong(grant.version)
                text(grant.keyId); text(grant.brokerInstallationId); data.writeLong(grant.policyGeneration)
                listOf(grant.requestId, grant.sessionId, grant.runId, grant.turnId, grant.actionId, grant.nonce,
                    grant.serviceName, grant.action, grant.definitionHash, grant.authorization).forEach(::text)
                data.writeLong(grant.issuedMs); data.writeLong(grant.expiresMs)
            }
            output.toByteArray()
        }
    }
}

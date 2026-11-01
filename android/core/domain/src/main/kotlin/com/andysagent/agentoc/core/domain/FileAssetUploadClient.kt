package com.andysagent.agentoc.core.domain

import com.andysagent.agentoc.core.network.AgentoCTransport
import com.andysagent.agentoc.core.network.ApiException
import com.andysagent.agentoc.core.network.ApiRequest
import com.andysagent.agentoc.core.network.ApiResponse
import com.andysagent.agentoc.core.network.SwitchingAgentoCTransport
import com.andysagent.agentoc.core.protocol.AgentocProtocol
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.*
import java.net.URI
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.Locale

/** Frozen file metadata; the durable resource owner supplies the original bytes. */
data class FileUploadInput(
    val requestId: String,
    val originalName: String,
    val mimeType: String,
    val sizeBytes: Long,
    val sha256: String,
)

data class TargetFileAsset(
    val instanceId: String,
    val sessionId: String,
    val assetId: String,
    val originalName: String,
    val mimeType: String,
    val sizeBytes: Long,
    val sha256: String,
    val ready: Boolean,
    val scopeContractVersion: Int? = null,
)

/**
 * Fixed-target control-plane client. It never owns a connection, queues legacy
 * retries or treats a ready attachment as an accepted message/finished Run.
 * The caller holds the target lease throughout each call.
 */
class FileAssetUploadClient(private val instanceId: String, private val transport: AgentoCTransport) {
    init {
        require(instanceId.isNotBlank())
        require(transport !is SwitchingAgentoCTransport) { "Uploads require a fixed target transport" }
    }

    /** Read-only, including version negotiation. No upload credentials are minted. */
    suspend fun requireSupport(scope: SessionScopeCondition? = null) = requireContract(scope)

    /** Probe before creating a Session; no context, asset or upload credential is created. */
    suspend fun requireScopedSupport() { requireUploadScope(); requireContract() }

    /** Read-only recovery never creates an upload intent. */
    suspend fun findReceipt(sessionId: String, input: FileUploadInput, scope: SessionScopeCondition? = null,
        checkAccess: suspend () -> Unit = {}): TargetFileAsset? {
        val frozen = validate(sessionId, input)
        require(scope == null || scope.validate().sessionId == sessionId)
        checkAccess(); requireContract(scope); checkAccess()
        return lookup(sessionId, frozen, scope).also { checkAccess() }
    }

    /** Explicit resumable upload. Lost replies propagate; the next call queries first. */
    suspend fun upload(sessionId: String, input: FileUploadInput, bytes: ByteArray, scope: SessionScopeCondition? = null,
        onProgress: (FileUploadProgress) -> Unit = {},
        checkAccess: suspend () -> Unit = {}): TargetFileAsset {
        val frozen = validate(sessionId, input)
        fun report(phase: FileUploadPhase, writtenBytes: Long? = null) {
            try { onProgress(FileUploadProgress(phase, frozen.sizeBytes, writtenBytes)) }
            catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (_: Exception) { /* Progress is observational, receipt validation is authoritative. */ }
        }
        require(scope == null || scope.validate().sessionId == sessionId)
        // Detach before suspension so caller mutation cannot change the signed body.
        require(bytes.size.toLong() == frozen.sizeBytes) { "File size differs from its frozen descriptor" }
        val body = bytes.copyOf()
        val digest = MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it) }
        require(digest == frozen.sha256) { "File digest differs from its frozen descriptor" }
        currentCoroutineContext().ensureActive()
        checkAccess(); requireContract(scope); checkAccess()
        report(FileUploadPhase.CHECKING)
        val previous = lookup(sessionId, frozen, scope)
        checkAccess()
        if (previous?.ready == true) { report(FileUploadPhase.CONFIRMED); return previous }
        report(FileUploadPhase.PREPARING)
        val intentBody = buildJsonObject {
            put("sessionId", sessionId); put("requestId", frozen.requestId)
            put("originalName", frozen.originalName); put("mimeType", frozen.mimeType)
            put("sizeBytes", frozen.sizeBytes); put("sha256", frozen.sha256)
        }.toString()
        val intent = json(execute(ApiRequest("POST", "/api/assets/upload-intents", intentBody,
            headers = scope?.headers().orEmpty(), contentType = "application/json")))
        checkAccess()
        check(intent["uploadContractVersion"]?.jsonPrimitive?.intOrNull == 1) { "Target did not acknowledge stable upload identity" }
        val asset = parseAsset(sessionId, frozen, intent, scope)
        check(previous == null || previous.assetId == asset.assetId) { "Upload identity changed at the target" }
        if (asset.ready) { report(FileUploadPhase.CONFIRMED); return asset }
        val upload = intent["upload"] as? JsonObject ?: error("Pending upload has no upload destination")
        val path = string(upload, "url")
        val method = string(upload, "method")
        val headers = (upload["headers"] as? JsonObject).orEmpty().mapValues { (_, value) ->
            (value as? JsonPrimitive)?.contentOrNull ?: error("Invalid upload header")
        }
        check(headers.keys.all { it.equals("Content-Type", ignoreCase = true) }) { "Unexpected upload credential header" }
        check(headers.values.none { '\r' in it || '\n' in it }) { "Invalid upload header value" }
        val mime = headers.entries.firstOrNull { it.key.equals("Content-Type", ignoreCase = true) }?.value ?: frozen.mimeType
        check(mime == frozen.mimeType) { "Upload content type differs from frozen metadata" }
        if (path.startsWith('/')) {
            check(method == "POST" && path == "/api/assets/${asset.assetId}/upload") { "Unexpected control-plane upload destination" }
        } else {
            val uri = URI(path)
            check(method == "PUT" && uri.scheme in setOf("http", "https") && !uri.host.isNullOrBlank()
                && uri.userInfo == null && uri.fragment == null) { "Invalid signed object upload destination" }
        }
        checkAccess()
        // Object-store credentials are not a PC control-plane delegation.
        val bodyHeaders = if (path.startsWith('/')) headers + scope?.headers().orEmpty() else headers
        report(FileUploadPhase.TRANSFERRING)
        val uploaded = execute(ApiRequest(method, path, headers = bodyHeaders, bodyBytes = body, contentType = mime,
            onBodyBytesWritten = { report(FileUploadPhase.TRANSFERRING, it) }))
        checkAccess()
        report(FileUploadPhase.VERIFYING)
        val finalizeBody = buildJsonObject {
            put("sizeBytes", frozen.sizeBytes)
            put("etag", uploaded.headers.entries.firstOrNull { it.key.equals("ETag", ignoreCase = true) }?.value.orEmpty())
        }.toString()
        val finalized = parseAsset(sessionId, frozen, json(execute(
            ApiRequest("POST", "/api/assets/${asset.assetId}/finalize", finalizeBody,
                headers = scope?.headers().orEmpty(), contentType = "application/json"),
        )), scope)
        checkAccess()
        check(finalized.assetId == asset.assetId && finalized.ready) { "Target did not acknowledge the verified file" }
        report(FileUploadPhase.CONFIRMED)
        return finalized
    }

    private suspend fun requireContract(scope: SessionScopeCondition? = null) {
        if (scope != null) {
            scope.validate()
            requireUploadScope()
        }
        val contract = json(execute(ApiRequest("GET", "/api/asset-upload-contract")))
        check(contract["version"]?.jsonPrimitive?.intOrNull == 1
            && contract["sha256Required"]?.jsonPrimitive?.booleanOrNull == true
            && contract["readonlyReceiptLookup"]?.jsonPrimitive?.booleanOrNull == true
            && (contract["maximumBytes"]?.jsonPrimitive?.longOrNull ?: 0) >= MAXIMUM_BYTES
            && (contract["requestIdMaximumLength"]?.jsonPrimitive?.intOrNull ?: 0) >= 200) {
            "Target does not support the stable upload contract"
        }
    }

    private suspend fun requireUploadScope() = requireSessionScopeEffects(transport, mapOf(
        "asset.upload.intent" to ("POST" to "/api/assets/upload-intents"),
        "asset.upload.body" to ("POST" to "/api/assets/{assetId}/upload"),
        "asset.upload.finalize" to ("POST" to "/api/assets/{assetId}/finalize"),
        "asset.upload.receipt" to ("GET" to "/api/assets/upload-intents?sessionId={sessionId}&requestId={requestId}"),
    ))

    private suspend fun lookup(sessionId: String, input: FileUploadInput, scope: SessionScopeCondition?): TargetFileAsset? {
        val response = try { execute(ApiRequest("GET", "/api/assets/upload-intents?sessionId=${encode(sessionId)}&requestId=${encode(input.requestId)}",
            headers = scope?.headers().orEmpty())) }
        catch (error: ApiException) {
            if (error.statusCode == 404 && error.code == "FILE_ASSET_NOT_FOUND") return null
            throw error
        }
        val receipt = json(response)
        check(receipt["uploadContractVersion"]?.jsonPrimitive?.intOrNull == 1) { "Unsupported upload receipt version" }
        return parseAsset(sessionId, input, receipt, scope)
    }

    private fun parseAsset(sessionId: String, input: FileUploadInput, payload: JsonObject, scope: SessionScopeCondition?): TargetFileAsset {
        val asset = payload["asset"] as? JsonObject ?: error("Missing file asset receipt")
        if (scope != null) check(asset["scopeContractVersion"] == JsonPrimitive(1)) { "Scoped upload receipt was downgraded" }
        val id = string(asset, "id")
        check(Regex("fasset_[a-f0-9]{24}").matches(id)) { "Invalid file asset identity" }
        val status = string(asset, "status")
        check(status in setOf("pending_upload", "ready")) { "Unknown upload state" }
        check(string(asset, "sessionId") == sessionId && string(asset, "originalName") == input.originalName
            && string(asset, "mimeType") == input.mimeType
            && asset["sizeBytes"]?.jsonPrimitive?.longOrNull == input.sizeBytes
            && string(asset, "sha256") == input.sha256) { "Upload receipt differs from the frozen file" }
        return TargetFileAsset(instanceId, sessionId, id, input.originalName, input.mimeType, input.sizeBytes, input.sha256, status == "ready",
            asset["scopeContractVersion"]?.jsonPrimitive?.intOrNull)
    }

    private fun validate(sessionId: String, input: FileUploadInput): FileUploadInput {
        require(sessionId.isNotBlank() && sessionId == sessionId.trim() && sessionId.length <= 256)
        require(input.requestId.isNotBlank() && input.requestId.length <= 200)
        require(input.originalName.isNotBlank() && input.originalName.length <= 255
            && input.originalName.none { it in "\\/\u0000\r\n" }) { "A bounded file name is required" }
        require(input.mimeType.length <= 256 && input.mimeType.none { it in "\u0000\r\n" })
        require(input.sizeBytes in 1..MAXIMUM_BYTES && Regex("[a-fA-F0-9]{64}").matches(input.sha256))
        return input.copy(requestId = input.requestId.trim(), originalName = input.originalName.trim().replace(Regex("\\s+"), " "),
            mimeType = input.mimeType.trim().lowercase(Locale.ROOT).ifBlank { "application/octet-stream" }, sha256 = input.sha256.lowercase(Locale.ROOT))
    }

    private suspend fun execute(request: ApiRequest): ApiResponse {
        val result = transport.execute(request)
        if (!result.isSuccessful) {
            val code = runCatching { json(result)["code"]?.jsonPrimitive?.contentOrNull }.getOrNull()
            throw ApiException(result.statusCode, code, "File upload request failed")
        }
        return result
    }
    private fun json(response: ApiResponse): JsonObject = AgentocProtocol.json.parseToJsonElement(response.body).jsonObject
    private fun string(value: JsonObject, key: String): String = (value[key] as? JsonPrimitive)?.contentOrNull ?: error("Missing $key")
    private fun encode(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    companion object { const val MAXIMUM_BYTES = 25L * 1024 * 1024 }
}

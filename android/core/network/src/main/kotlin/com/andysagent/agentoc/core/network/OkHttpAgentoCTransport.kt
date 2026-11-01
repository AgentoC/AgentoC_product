package com.andysagent.agentoc.core.network

import com.andysagent.agentoc.core.protocol.ErrorResponseDto
import com.andysagent.agentoc.core.protocol.ProtocolCodec
import com.andysagent.agentoc.core.protocol.SessionEventDto
import com.andysagent.agentoc.core.protocol.WebSocketPushDto
import com.andysagent.agentoc.core.p2p.P2PHttpRequest
import com.andysagent.agentoc.core.p2p.P2PProtocol
import com.andysagent.agentoc.core.p2p.P2PSession
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.serializer
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Only fixed categories reach logs; exception text may contain private data. */
internal fun carrierFailureCategory(error: Throwable): String = when (error.message) {
    "P2P transport closed" -> "transport_closed"
    "DataChannel is null", "DataChannel is not open", "DataChannel closed while sending request" -> "channel_unavailable"
    "P2P request timed out", "P2P stream request timed out" -> "request_timeout"
    "Invalid P2P response stream" -> "invalid_response_stream"
    else -> "other"
}

private fun carrierHeaders(request: ApiRequest): MutableMap<String, String> = request.headers.toMutableMap().apply {
    if (keys.none { it.equals("Content-Type", ignoreCase = true) }) {
        val type = request.contentType ?: when {
            request.bodyBytes != null -> "application/octet-stream"
            request.body != null -> "application/json"
            else -> null
        }
        if (type != null) put("Content-Type", type)
    }
}

private fun recordCarrierFailure(kind: String, failure: Throwable, isOpen: Boolean) {
    // Android's mockable JVM jar can reject Log calls; diagnostics must never
    // change request handling on either runtime.
    runCatching { android.util.Log.w("AgentoC.Carrier", "$kind failure=${carrierFailureCategory(failure)} open=$isOpen") }
}

class OkHttpAgentoCTransport(
    private val endpointProvider: () -> String,
    private val credentialProvider: () -> String?,
    private val client: OkHttpClient = defaultClient(),
    private val codec: ProtocolCodec = ProtocolCodec(),
    private val onAuthenticationRequired: (() -> Unit)? = null,
    /** Bound computer traffic cannot fall back to direct HTTP after carrier loss. */
    private val requireVerifiedCarrier: Boolean = false,
    private val credentialRejectionHandler: CredentialRejectionHandler? = null,
    private val onCarrierUnavailable: ((P2PSession?) -> Unit)? = null,
) : AgentoCTransport {
    private val invalidationEvents = MutableSharedFlow<InvalidationHint>(extraBufferCapacity = 64)
    private val socketScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutableConnectionState = MutableStateFlow(RuntimeConnectionState.Disconnected)
    private var reconnectJob: Job? = null
    private var reconnectAttempt = 0
    @Volatile private var closeRequested = true
    private var webSocket: WebSocket? = null
    private val p2pSession = AtomicReference<P2PSession?>(null)
    private val turnSession = AtomicReference<P2PSession?>(null)
    private val recoveryRequested = java.util.concurrent.atomic.AtomicBoolean(false)

    override val invalidations: Flow<InvalidationHint> = invalidationEvents.asSharedFlow()
    override val connectionState: StateFlow<RuntimeConnectionState> = mutableConnectionState.asStateFlow()
    override val requiresEventPolling: Boolean
        get() = requireVerifiedCarrier || hasOpenCarrier() || endpointProvider().trimEnd('/').isBlank()

    fun updateCarrierConnectionState(state: RuntimeConnectionState) {
        if (hasOpenCarrier()) closeInvalidationSocketForCarrier()
        // A queued supervisor notification cannot revive a closed carrier.
        mutableConnectionState.value = if (requireVerifiedCarrier && state == RuntimeConnectionState.Connected && !hasOpenCarrier()) {
            RuntimeConnectionState.Connecting
        } else state
    }

    fun setP2PSession(session: P2PSession) {
        p2pSession.getAndSet(session)?.takeIf { it !== session }?.close()
        recoveryRequested.set(false)
    }

    fun clearP2PSession(session: P2PSession? = null) {
        if (session == null) p2pSession.set(null) else p2pSession.compareAndSet(session, null)
    }

    fun setTurnSession(session: P2PSession) {
        turnSession.getAndSet(session)?.takeIf { it !== session }?.close()
        recoveryRequested.set(false)
    }

    fun clearTurnSession(session: P2PSession? = null) {
        if (session == null) turnSession.set(null)
        else turnSession.compareAndSet(session, null)
    }

    private fun hasOpenCarrier(): Boolean = p2pSession.get()?.isOpen == true || turnSession.get()?.isOpen == true

    override fun markAuthenticationRequired() {
        mutableConnectionState.value = RuntimeConnectionState.AuthenticationRequired
    }

    override suspend fun execute(request: ApiRequest): ApiResponse = withContext(Dispatchers.IO) {
        val endpoint = endpointProvider().trimEnd('/')
        // Signed asset uploads may target storage outside the AgentoC server.
        // They must use the URL and headers returned by the upload intent;
        // stripping the host and sending them over a peer/TURN control-plane
        // session would upload to the wrong origin. Relative API paths remain
        // governed by the server bootstrap -> TURN-first -> P2P upgrade lock.
        val serverRelativeRequest = !request.path.startsWith("http://") && !request.path.startsWith("https://")
        if (serverRelativeRequest) {
            p2pSession.get()?.takeIf { it.isOpen }?.let { return@withContext executeViaP2P(request, it) }
            turnSession.get()?.takeIf { it.isOpen }?.let { return@withContext executeViaTurn(request, it) }
            if (requireVerifiedCarrier) {
                reportUnavailableCarrier(null)
                throw ApiException(0, "CARRIER_UNAVAILABLE", "The computer is reconnecting", retryable = true)
            }
        }
        if (endpoint.isBlank() && serverRelativeRequest) {
            throw IOException("No verified TURN/P2P carrier is available")
        }
        val url = if (request.path.startsWith("http://") || request.path.startsWith("https://")) request.path else "$endpoint${request.path}"
        val builder = Request.Builder().url(url)
        request.headers.forEach { (name, value) -> builder.header(name, value) }
        val attemptedCredential = if (serverRelativeRequest) credentialProvider()?.takeIf { it.isNotBlank() } else null
        if (serverRelativeRequest) {
            attemptedCredential?.let { builder.header("Authorization", "Bearer $it") }
            request.requestId?.let { builder.header("X-AgentoC-Request-Id", it) }
            request.idempotencyKey?.let { builder.header("Idempotency-Key", it) }
        }
        val rawBody = request.bodyBytes?.toRequestBody(
            (request.contentType ?: "application/octet-stream").toMediaType(),
        ) ?: request.body?.toRequestBody(request.contentType?.toMediaType() ?: JSON_MEDIA_TYPE)
        val body = if (rawBody != null && request.onBodyBytesWritten != null)
            ProgressRequestBody(rawBody, request.onBodyBytesWritten) else rawBody
        when (request.method.uppercase()) {
            "GET" -> builder.get()
            "POST" -> builder.post(body ?: EMPTY_BODY)
            "PUT" -> builder.put(body ?: EMPTY_BODY)
            "PATCH" -> builder.patch(body ?: EMPTY_BODY)
            "DELETE" -> if (body == null) builder.delete() else builder.delete(body)
            else -> builder.method(request.method.uppercase(), body)
        }
        try {
            val apiResponse = executeHttpCancellable(builder.build())
            if (!apiResponse.isSuccessful) throw apiResponse.toApiException(codec)
            apiResponse
        } catch (error: ApiException) {
            currentCoroutineContext().ensureActive()
            if (serverRelativeRequest) handleAuthenticationFailure(error, attemptedCredential)
            throw error
        } catch (error: IOException) {
            currentCoroutineContext().ensureActive()
            val rootCause = generateSequence<Throwable>(error) { it.cause }.take(8).last()
            // Exception messages can contain arbitrary credentials, URLs and
            // response data. Expose only a fixed, non-user-controlled category.
            val diagnostic = when (rootCause) {
                is java.net.UnknownHostException -> "UnknownHostException"
                is java.net.SocketTimeoutException -> "SocketTimeoutException"
                is java.net.ConnectException -> "ConnectException"
                is javax.net.ssl.SSLException -> "SSLException"
                is java.net.SocketException -> "SocketException"
                else -> "IOException"
            }
            throw ApiException(0, "NETWORK_ERROR", "Network request failed ($diagnostic)", retryable = true)
        }
    }

    /** Keep cancellation attached until the whole response body has been read. */
    private suspend fun executeHttpCancellable(request: Request): ApiResponse = suspendCancellableCoroutine { continuation ->
        val call = client.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, error: IOException) {
                continuation.resumeWithException(error)
            }

            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                try {
                    val result = response.use {
                        val bytes = it.body?.bytes() ?: ByteArray(0)
                        ApiResponse(it.code, bytes.toString(Charsets.UTF_8), it.headers.toMap(), bytes)
                    }
                    continuation.resume(result)
                } catch (error: Exception) {
                    continuation.resumeWithException(error)
                }
            }
        })
    }

    private suspend fun executeViaP2P(request: ApiRequest, session: P2PSession): ApiResponse {
        val path = request.path.takeIf { it.startsWith("/") } ?: runCatching {
            val uri = java.net.URI(request.path)
            buildString {
                append(uri.rawPath?.takeIf { it.isNotBlank() } ?: "/")
                uri.rawQuery?.let { append('?').append(it) }
            }
        }.getOrNull() ?: throw ApiException(0, "P2P_REQUEST_INVALID", "P2P request path is invalid", retryable = false)
        val headers = carrierHeaders(request)
        val attemptedCredential = credentialProvider()?.takeIf { it.isNotBlank() }
        attemptedCredential?.let { headers["Authorization"] = "Bearer $it" }
        request.requestId?.let { headers["X-AgentoC-Request-Id"] = it }
        request.idempotencyKey?.let { headers["Idempotency-Key"] = it }
        val result = session.request(P2PHttpRequest(
            // Business IDs (for example android:UUID) stay in headers/body.
            // Each carrier attempt needs an independent, frame-safe correlation ID.
            id = java.util.UUID.randomUUID().toString(),
            method = request.method.uppercase(),
            path = path,
            headers = headers,
            bodyBase64 = request.bodyBytes?.let(P2PProtocol::encodeBody)
                ?: request.body?.let(P2PProtocol::encodeBody)
                ?: "",
        )).getOrElse { failure ->
            if (failure is kotlinx.coroutines.CancellationException) throw failure
            recordCarrierFailure("p2p", failure, session.isOpen)
            reportUnavailableCarrier(session)
            throw ApiException(0, "P2P_NETWORK_ERROR", "P2P request failed", retryable = true)
        }
        val remoteError = result.error
        if (remoteError != null) {
            throw ApiException(0, "P2P_REMOTE_ERROR", remoteError, retryable = false)
        }
        val response = ApiResponse(
            statusCode = result.status,
            body = P2PProtocol.decodeBodyToString(result.bodyBase64),
            headers = result.headers,
            bodyBytes = runCatching { P2PProtocol.decodeBody(result.bodyBase64) }.getOrDefault(ByteArray(0)),
        )
        if (!response.isSuccessful) {
            val error = response.toApiException(codec)
            handleAuthenticationFailure(error, attemptedCredential)
            throw error
        }
        return response
    }

    private suspend fun executeViaTurn(request: ApiRequest, session: P2PSession): ApiResponse {
        val path = request.path.takeIf { it.startsWith("/") } ?: runCatching {
            val uri = java.net.URI(request.path)
            buildString {
                append(uri.rawPath?.takeIf { it.isNotBlank() } ?: "/")
                uri.rawQuery?.let { append('?').append(it) }
            }
        }.getOrNull() ?: throw ApiException(0, "TURN_REQUEST_INVALID", "TURN request path is invalid", retryable = false)
        val headers = carrierHeaders(request)
        val attemptedCredential = credentialProvider()?.takeIf { it.isNotBlank() }
        attemptedCredential?.let { headers["Authorization"] = "Bearer $it" }
        request.requestId?.let { headers["X-AgentoC-Request-Id"] = it }
        request.idempotencyKey?.let { headers["Idempotency-Key"] = it }
        val result = session.request(P2PHttpRequest(
            // Business IDs (for example android:UUID) stay in headers/body.
            // Each carrier attempt needs an independent, frame-safe correlation ID.
            id = java.util.UUID.randomUUID().toString(),
            method = request.method.uppercase(),
            path = path,
            headers = headers,
            bodyBase64 = request.bodyBytes?.let(P2PProtocol::encodeBody)
                ?: request.body?.let(P2PProtocol::encodeBody)
                ?: "",
        )).getOrElse { failure ->
            if (failure is kotlinx.coroutines.CancellationException) throw failure
            recordCarrierFailure("turn", failure, session.isOpen)
            reportUnavailableCarrier(session)
            throw ApiException(0, "TURN_NETWORK_ERROR", "TURN request failed", retryable = true)
        }
        val remoteError = result.error
        if (remoteError != null) {
            throw ApiException(0, "TURN_REMOTE_ERROR", remoteError, retryable = false)
        }
        val response = ApiResponse(
            statusCode = result.status,
            body = P2PProtocol.decodeBodyToString(result.bodyBase64),
            headers = result.headers,
            bodyBytes = runCatching { P2PProtocol.decodeBody(result.bodyBase64) }.getOrDefault(ByteArray(0)),
        )
        if (!response.isSuccessful) {
            val error = response.toApiException(codec)
            handleAuthenticationFailure(error, attemptedCredential)
            throw error
        }
        return response
    }

    private fun reportUnavailableCarrier(failed: P2PSession?) {
        if (mutableConnectionState.value == RuntimeConnectionState.AuthenticationRequired) return
        if (failed == null && hasOpenCarrier()) return
        if (failed != null && turnSession.get() !== failed && p2pSession.get() !== failed) return
        if (recoveryRequested.compareAndSet(false, true)) {
            mutableConnectionState.value = RuntimeConnectionState.Reconnecting
            onCarrierUnavailable?.invoke(failed)
        }
        // This is a recovery signal only. The failed business request is never replayed here.
    }

    override fun connectInvalidationSocket() {
        if (hasOpenCarrier()) {
            closeInvalidationSocketForCarrier()
            mutableConnectionState.value = RuntimeConnectionState.Connected
            return
        }
        if (requireVerifiedCarrier) return
        if (endpointProvider().trimEnd('/').isBlank()) return
        val endpoint = endpointProvider().trimEnd('/')
        if (endpoint.isBlank()) {
            mutableConnectionState.value = RuntimeConnectionState.Error
            return
        }
        closeRequested = false
        reconnectAttempt = 0
        reconnectJob?.cancel()
        webSocket?.cancel()
        openInvalidationSocket(endpoint)
    }

    private fun openInvalidationSocket(endpoint: String) {
        if (closeRequested) return
        val wsUrl = when {
            endpoint.startsWith("https://") -> "wss://${endpoint.removePrefix("https://")}/ws"
            endpoint.startsWith("http://") -> "ws://${endpoint.removePrefix("http://")}/ws"
            else -> {
                mutableConnectionState.value = RuntimeConnectionState.Error
                return
            }
        }
        mutableConnectionState.value = if (reconnectAttempt == 0) {
            RuntimeConnectionState.Connecting
        } else {
            RuntimeConnectionState.Reconnecting
        }
        val attemptedCredential = credentialProvider()?.takeIf { it.isNotBlank() }
        val request = Request.Builder().url(wsUrl).apply {
            attemptedCredential?.let { header("Authorization", "Bearer $it") }
        }.build()
        val socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                if (webSocket !== this@OkHttpAgentoCTransport.webSocket) return
                reconnectAttempt = 0
                mutableConnectionState.value = RuntimeConnectionState.Connected
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket === this@OkHttpAgentoCTransport.webSocket && !hasOpenCarrier()) parseInvalidation(text)
            }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (webSocket === this@OkHttpAgentoCTransport.webSocket && !hasOpenCarrier()) parseInvalidation(bytes.utf8())
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                if (webSocket !== this@OkHttpAgentoCTransport.webSocket) return
                if (response != null && requiresAuthentication(response)) {
                    socketScope.launch {
                        requireAuthentication(attemptedCredential,
                            stillCurrent = { webSocket === this@OkHttpAgentoCTransport.webSocket },
                            onInvalidated = { invalidationEvents.tryEmit(InvalidationHint("authentication_required")) })
                    }
                    return
                }
                invalidationEvents.tryEmit(InvalidationHint("connection_failed"))
                scheduleReconnect(endpoint)
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket !== this@OkHttpAgentoCTransport.webSocket) return
                invalidationEvents.tryEmit(InvalidationHint("connection_closed"))
                if (closeRequested) mutableConnectionState.value = RuntimeConnectionState.Disconnected
                else scheduleReconnect(endpoint)
            }
        })
        webSocket = socket
    }

    private fun closeInvalidationSocketForCarrier() {
        closeRequested = true
        reconnectJob?.cancel()
        reconnectJob = null
        val socket = webSocket
        webSocket = null
        socket?.cancel()
    }

    private suspend fun handleAuthenticationFailure(error: ApiException, attemptedCredential: String?) {
        currentCoroutineContext().ensureActive()
        if (requiresAuthentication(error)) requireAuthentication(attemptedCredential)
    }

    private suspend fun requireAuthentication(attemptedCredential: String?, stillCurrent: () -> Boolean = { true }, onInvalidated: () -> Unit = {}) {
        val invalidate = {
            if (stillCurrent()) {
                mutableConnectionState.value = RuntimeConnectionState.AuthenticationRequired
                onAuthenticationRequired?.invoke()
                onInvalidated()
            }
        }
        if (credentialRejectionHandler != null) credentialRejectionHandler.reject(attemptedCredential, stillCurrent, invalidate)
        else if (credentialProvider()?.takeIf { it.isNotBlank() } == attemptedCredential) invalidate()
    }

    private fun requiresAuthentication(error: ApiException): Boolean =
        error.statusCode == 401 || (error.statusCode == 403 && error.code == "DEVICE_REVOKED")

    private fun requiresAuthentication(response: okhttp3.Response): Boolean {
        if (response.code == 401) return true
        if (response.code != 403) return false
        val error = runCatching {
            codec.decode(serializer<ErrorResponseDto>(), response.peekBody(Long.MAX_VALUE).string())
        }.getOrNull()
        return error?.code == "DEVICE_REVOKED"
    }

    private fun scheduleReconnect(endpoint: String) {
        if (closeRequested || reconnectJob?.isActive == true) return
        mutableConnectionState.value = RuntimeConnectionState.Reconnecting
        val delayMs = minOf(30_000L, 1_000L shl reconnectAttempt.coerceAtMost(5))
        reconnectAttempt += 1
        reconnectJob = socketScope.launch {
            delay(delayMs)
            if (!closeRequested) openInvalidationSocket(endpoint)
        }
    }

    override suspend fun close() {
        closeRequested = true
        reconnectJob?.cancel()
        reconnectJob = null
        webSocket?.close(1000, "client closed")
        webSocket = null
        turnSession.getAndSet(null)?.close()
        p2pSession.getAndSet(null)?.close()
        mutableConnectionState.value = RuntimeConnectionState.Disconnected
    }

    private fun parseInvalidation(body: String) {
        runCatching {
            val value = codec.decode(serializer<WebSocketPushDto>(), body)
            val events = value.events
            invalidationEvents.tryEmit(InvalidationHint(value.type, value.sessionId, events))
        }.onFailure {
            invalidationEvents.tryEmit(InvalidationHint("protocol_error"))
        }
    }

    private fun ApiResponse.toApiException(codec: ProtocolCodec): ApiException {
        val parsed = runCatching { codec.decode(serializer<ErrorResponseDto>(), body) }.getOrNull()
        return ApiException(
            statusCode = statusCode,
            code = parsed?.code,
            message = parsed?.error?.takeIf { it.isNotBlank() } ?: "AgentoC request failed ($statusCode)",
            retryAfterMs = retryAfterDelayMs(),
            headers = headers,
        )
    }

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private val EMPTY_BODY = "".toRequestBody(JSON_MEDIA_TYPE)

        private fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(12, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .pingInterval(30, TimeUnit.SECONDS)
            .build()
    }
}

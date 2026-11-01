package com.andysagent.agentoc.core.domain

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.andysagent.agentoc.core.database.AgentoCDatabase
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.network.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class RoomSessionDirectorySyncTest {
    @Test fun durableEventCompactQueryFallsBackOnlyForLegacyRouteDenial() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, AgentoCDatabase::class.java).allowMainThreadQueries().build()
        val requests = mutableListOf<String>()
        var code = "temporary_control_route_denied"
        val carrier = object : AgentoCTransport {
            override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
            override val invalidations: Flow<InvalidationHint> = emptyFlow()
            override suspend fun execute(request: ApiRequest): ApiResponse {
                requests += request.path
                if ("&compact=1" in request.path) throw ApiException(403, code, "denied")
                return ApiResponse(200, """{"sessionId":"s","events":[]}""")
            }
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val repository = RoomSessionRepository(database, carrier)
        try {
            repository.refreshEvents("s")
            assertEquals(2, requests.size)
            assertTrue("&compact=1" in requests[0])
            assertEquals(requests[0].replace("&compact=1", ""), requests[1])
            requests.clear(); code = "permission_denied"
            try { repository.refreshEvents("s"); fail("Authorization failure must not fall back") }
            catch (error: SessionRepositoryException) { assertEquals("permission_denied", error.code) }
            assertEquals(1, requests.size)
        } finally { repository.close(); database.close() }
    }

    @Test fun olderTemporaryCarrierFallsBackOnlyForItsRouteDenial() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, AgentoCDatabase::class.java).allowMainThreadQueries().build()
        val requests = mutableListOf<String>()
        var errorCode = "temporary_control_route_denied"
        val carrier = object : AgentoCTransport {
            override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
            override val invalidations: Flow<InvalidationHint> = emptyFlow()
            override suspend fun execute(request: ApiRequest): ApiResponse {
                requests += request.path
                if (request.path.endsWith("?view=summary")) throw ApiException(403, errorCode, "denied")
                return ApiResponse(200, """{"sessions":[{"id":"one","name":"One"}]}""")
            }
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val repository = RoomSessionRepository(database, carrier)
        try {
            repository.refreshSessions()
            assertEquals(listOf("/api/sessions?view=summary", "/api/sessions"), requests)
            assertEquals("one", repository.observeSessions().first().single().id)
            requests.clear(); errorCode = "permission_denied"
            try { repository.refreshSessions(); fail("Authorization failure must not fall back") }
            catch (error: SessionRepositoryException) { assertEquals("permission_denied", error.code) }
            assertEquals(listOf("/api/sessions?view=summary"), requests)
        } finally { repository.close(); database.close() }
    }

    @Test fun deletingOnOneClientRemovesTheIdleSessionOnAnotherWithoutReconnect() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val firstDb = Room.inMemoryDatabaseBuilder(context, AgentoCDatabase::class.java).allowMainThreadQueries().build()
        val peerDb = Room.inMemoryDatabaseBuilder(context, AgentoCDatabase::class.java).allowMainThreadQueries().build()
        val exists = AtomicBoolean(true)
        val deletes = AtomicInteger()
        fun carrier() = object : AgentoCTransport {
            override val requiresEventPolling = true
            override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
            override val invalidations: Flow<InvalidationHint> = emptyFlow()
            override suspend fun execute(request: ApiRequest): ApiResponse = when {
                request.method == "DELETE" && request.path == "/api/sessions/shared-idle" -> {
                    exists.set(false); deletes.incrementAndGet(); ApiResponse(200, "{}")
                }
                request.method == "GET" && request.path == "/api/sessions?view=summary" -> ApiResponse(200,
                    if (exists.get()) """{"sessions":[{"id":"shared-idle","name":"Shared","status":"idle"}]}"""
                    else """{"sessions":[]}""")
                else -> error("Unexpected request: ${request.method} ${request.path}")
            }
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val first = RoomSessionRepository(firstDb, carrier())
        val peer = RoomSessionRepository(peerDb, carrier())
        try {
            first.refreshSessions(); peer.refreshSessions()
            assertEquals(1, peer.observeSessions().first().size)
            peer.startLiveSync()
            first.deleteSession("shared-idle")
            assertEquals(1, deletes.get())
            assertTrue(first.observeSessions().first().isEmpty())
            withTimeout(6_000) { peer.observeSessions().first { it.isEmpty() } }
            Unit
        } finally { first.close(); peer.close(); firstDb.close(); peerDb.close() }
    }
}

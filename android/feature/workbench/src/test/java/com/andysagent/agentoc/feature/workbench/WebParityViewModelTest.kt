package com.andysagent.agentoc.feature.workbench

import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.domain.AccountDirectoryDevice
import com.andysagent.agentoc.core.network.AgentoCTransport
import com.andysagent.agentoc.core.network.ApiRequest
import com.andysagent.agentoc.core.network.ApiResponse
import com.andysagent.agentoc.core.network.InvalidationHint
import com.andysagent.agentoc.core.protocol.AgentocProtocol
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.assertNotNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

@OptIn(ExperimentalCoroutinesApi::class)
class WebParityViewModelTest {
    @Test
    fun `current session context does not request navigation to chat`() {
        val viewModel = WebParityViewModel(WebParityRepository(RecordingParityTransport()))

        viewModel.setOpenSessionId("session-current")

        assertEquals("session-current", viewModel.state.value.openSessionId)
        assertEquals(null, viewModel.state.value.pendingOpenSessionId)
    }

    @Test
    fun `account computer rename uses the account directory mutation`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            var renamed: Pair<String, String>? = null
            val viewModel = WebParityViewModel(
                repository = WebParityRepository(RecordingParityTransport()),
                accountDevicesProvider = {
                    listOf(AccountDirectoryDevice("rdev_office", "instance", "Office PC", "computer"))
                },
                accountDeviceRenamer = { id, name -> renamed = id to name },
            )

            viewModel.onEvent(WebParityEvent.OpenPage(WebParityPage.Devices))
            advanceUntilIdle()
            viewModel.onEvent(WebParityEvent.RenameDevice("rdev_office", "Work computer"))
            advanceUntilIdle()

            assertEquals("rdev_office" to "Work computer", renamed)
            assertEquals(null, viewModel.state.value.error)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `account device directory hides phone records from manage devices`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val viewModel = WebParityViewModel(
                repository = WebParityRepository(RecordingParityTransport()),
                accountDevicesProvider = {
                    listOf(
                        AccountDirectoryDevice("rdev_office", "office", "Office PC", "computer"),
                        AccountDirectoryDevice("adev_phone", "phone", "Pixel", "phone"),
                    )
                },
            )

            viewModel.onEvent(WebParityEvent.OpenPage(WebParityPage.Devices))
            advanceUntilIdle()

            assertEquals(listOf("rdev_office"), viewModel.state.value.devices.map { it.id })
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `device page never falls back to target runtime when account directory is unavailable`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val transport = RecordingParityTransport()
            val viewModel = WebParityViewModel(
                repository = WebParityRepository(transport),
                accountDevicesProvider = { null },
            )

            viewModel.onEvent(WebParityEvent.OpenPage(WebParityPage.Devices))
            advanceUntilIdle()

            assertTrue(transport.requests.none { it.path.contains("/api/device-pairing/") })
            assertEquals(emptyList(), viewModel.state.value.devices)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `harness page falls back to an available computer catalog`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val viewModel = WebParityViewModel(
                repository = WebParityRepository(RecordingParityTransport()),
                harnessTargetsProvider = {
                    listOf(
                        WebHarnessTargetSnapshot(WebHarnessTarget("offline", "Offline", available = false)),
                        WebHarnessTargetSnapshot(
                            WebHarnessTarget("online", "Office computer"),
                            listOf(WebHarness(id = "codex", name = "Codex", installed = true)),
                        ),
                    )
                },
                currentTargetIdProvider = { "offline" },
            )

            viewModel.onEvent(WebParityEvent.OpenPage(WebParityPage.Harnesses))
            advanceUntilIdle()

            assertEquals(listOf("codex"), viewModel.state.value.harnesses.map { it.id })
            assertEquals(listOf("offline", "online"), viewModel.state.value.harnessTargets.map { it.instanceId })
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `agent create and edit preserve server supported profile fields`() = runTest {
        val transport = RecordingParityTransport()
        val repository = WebParityRepository(transport)

        repository.createAgent(
            name = "Report helper",
            systemPrompt = "Prepare concise reports",
            tool = "claude-bidi",
            welcomeMessage = "What should we prepare?",
            skills = listOf("reporting", "files", "reporting"),
        )
        repository.updateAgent(
            id = "agent_123",
            name = "Updated helper",
            systemPrompt = "Use the latest report",
            tool = "codex",
            welcomeMessage = "Ready",
            skills = listOf("reports"),
        )

        assertEquals(2, transport.requests.size)
        val create = AgentocProtocol.json.parseToJsonElement(transport.requests[0].body!!).jsonObject
        assertEquals("claude-bidi", create["tool"]!!.jsonPrimitive.content)
        assertEquals("What should we prepare?", create["welcomeMessage"]!!.jsonPrimitive.content)
        assertEquals(listOf("reporting", "files"), create["skills"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("PATCH", transport.requests[1].method)
        assertEquals("/api/agents/agent_123", transport.requests[1].path)
        assertNotNull(transport.requests[1].body)
    }

    @Test
    fun `schedule follow-up without a session fails before making a request`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val transport = RecordingParityTransport()
            val viewModel = WebParityViewModel(WebParityRepository(transport))

            viewModel.onEvent(WebParityEvent.CreateTrigger("Follow up", "Check the report", "30", null))
            advanceUntilIdle()

            assertEquals("Open a session before scheduling follow-up work", viewModel.state.value.error)
            assertTrue(transport.requests.isEmpty())
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `schedule follow-up sends session and runtime selection`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val transport = RecordingParityTransport()
            val viewModel = WebParityViewModel(WebParityRepository(transport))

            viewModel.onEvent(
                WebParityEvent.CreateTrigger(
                    title = "Weekly export",
                    text = "Prepare the report",
                    delayMinutes = "7",
                    sessionId = "session-1",
                    tool = "codex",
                    model = "gpt-5.4",
                    effort = "high",
                    thinking = true,
                ),
            )
            advanceUntilIdle()

            val request = transport.requests.single()
            assertEquals("POST", request.method)
            assertEquals("/api/triggers", request.path)
            val body = AgentocProtocol.json.parseToJsonElement(request.body!!).jsonObject
            assertEquals("session-1", body["sessionId"]!!.jsonPrimitive.content)
            assertEquals("codex", body["tool"]!!.jsonPrimitive.content)
            assertEquals("gpt-5.4", body["model"]!!.jsonPrimitive.content)
            assertEquals("high", body["effort"]!!.jsonPrimitive.content)
            assertEquals("true", body["thinking"]!!.jsonPrimitive.content)
            assertEquals("true", body["enabled"]!!.jsonPrimitive.content)
            assertTrue(body["scheduledAt"]!!.jsonPrimitive.content.isNotBlank())
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `workspace file loading preserves raw bytes and response metadata`() = runTest {
        val bytes = "# Report\nready".toByteArray()
        val transport = RecordingParityTransport(
            ApiResponse(
                200,
                bytes.toString(Charsets.UTF_8),
                headers = mapOf("Content-Type" to "text/markdown; charset=utf-8", "Content-Disposition" to "inline; filename=report.md"),
                bodyBytes = bytes,
            ),
        )
        val payload = WebParityRepository(transport).loadFile("reports/report.md")

        assertEquals("report.md", payload.name)
        assertEquals("text/markdown", payload.mimeType)
        assertTrue(bytes.contentEquals(payload.bytes))
        assertEquals("/api/workspace-files/content?workspace=~&path=reports%2Freport.md", transport.requests.single().path)
    }

    @Test
    fun `project location browser loads remote drives and direct folder children`() = runTest {
        val transport = RecordingParityTransport(responder = { request ->
            when (request.path) {
                "/api/browse?roots=1" -> ApiResponse(
                    200,
                    """{"roots":[{"name":"C:\\","path":"C:\\"},{"name":"G:\\","path":"G:\\"}]}""",
                )
                "/api/browse?path=G%3A%5C&mode=directories" -> ApiResponse(
                    200,
                    """{"path":"G:\\","parent":null,"children":[{"name":"AgentoC","path":"G:\\AgentoC"}]}""",
                )
                else -> ApiResponse(404, """{"error":"Unexpected request"}""")
            }
        })
        val repository = WebParityRepository(transport)

        val roots = repository.loadProjectFolderRoots()
        val directory = repository.loadProjectFolderDirectory("G:\\")

        assertEquals(listOf("C:\\", "G:\\"), roots.map(ProjectFolderLocation::name))
        assertEquals("G:\\", directory.path)
        assertEquals(null, directory.parent)
        assertEquals(listOf("AgentoC"), directory.children.map(ProjectFolderLocation::name))
        assertEquals(
            listOf("/api/browse?roots=1", "/api/browse?path=G%3A%5C&mode=directories"),
            transport.requests.map(ApiRequest::path),
        )
    }

    @Test
    fun `connector OAuth uses the Web authorization route and returns its URL`() = runTest {
        val transport = RecordingParityTransport(ApiResponse(200, "{\"authUrl\":\"https://github.com/login/oauth\"}"))
        val url = WebParityRepository(transport).startConnectorOAuth("github")

        assertEquals("https://github.com/login/oauth", url)
        assertEquals("POST", transport.requests.single().method)
        assertEquals("/api/connectors/github/authorize", transport.requests.single().path)
    }

    @Test
    fun `provider OAuth credential is submitted to the active job`() = runTest {
        val transport = RecordingParityTransport()
        val pasted = "https://example.test/auth?text=secret%2Bvalue&state=abc"
        WebParityRepository(transport).submitProviderOAuthCredential("job_1", pasted)

        val request = transport.requests.single()
        assertEquals("POST", request.method)
        assertEquals("/api/native-provider-oauth/jobs/job_1/input", request.path)
        val body = Json.parseToJsonElement(request.body!!).jsonObject
        assertEquals(pasted, body["credential"]!!.jsonPrimitive.content)
    }

    @Test
    fun `provider rotation uses the server configuration endpoint`() = runTest {
        val transport = RecordingParityTransport()
        val repository = WebParityRepository(transport)
        repository.updateProviderRotation(true, listOf("agy_a", "agy_b"))

        val request = transport.requests.single()
        assertEquals("PATCH", request.method)
        assertEquals("/api/native-providers/agy/rotation", request.path)
        assertTrue(request.body!!.contains("agy_a"))
    }
}

private class RecordingParityTransport(
    private val response: ApiResponse = ApiResponse(200, "{}"),
    private val responder: ((ApiRequest) -> ApiResponse)? = null,
) : AgentoCTransport {
    private val state = MutableStateFlow(RuntimeConnectionState.Connected)
    override val connectionState: StateFlow<RuntimeConnectionState> = state
    override val invalidations: Flow<InvalidationHint> = MutableSharedFlow()
    val requests = mutableListOf<ApiRequest>()

    override suspend fun execute(request: ApiRequest): ApiResponse {
        requests += request
        return responder?.invoke(request) ?: response
    }

    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
}

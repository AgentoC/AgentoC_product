package com.andysagent.agentoc.feature.workbench

import com.andysagent.agentoc.core.network.ApiRequest
import com.andysagent.agentoc.core.network.ApiResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.*
import kotlin.test.*

@OptIn(ExperimentalCoroutinesApi::class)
class ProviderInstancesTest {
    private fun provider(id: String = "p", sync: String = "shared", auth: String = "api-key", fingerprint: String = "fp") =
        WebProvider(id, "Same name", "", true, authType = auth, syncId = sync, credentialFingerprint = fingerprint)
    private fun snapshot(id: String, vararg providers: WebProvider) = ProviderInstanceSnapshot(
        ProviderInstance(id, id), loading = false, available = true, snapshot = WebParitySnapshot(providers = providers.toList()))

    @Test fun `merge by sync identity not by name or local provider id`() {
        val groups = accountProviderGroups(listOf(snapshot("a", provider("a-local")),
            snapshot("b", provider("b-local"), provider("unrelated", "different"))))
        assertEquals(2, groups.size)
        assertEquals(listOf("a-local", "b-local"), groups.first().copies.map { it.provider.id })
        assertTrue(groups.first().configurationMatches)
    }

    @Test fun `OAuth and legacy rows remain separate even with matching ids`() {
        val groups = accountProviderGroups(listOf(snapshot("a", provider(auth = "oauth"), provider("legacy", "")),
            snapshot("b", provider(auth = "oauth"), provider("legacy", ""))))
        assertEquals(4, groups.size)
    }

    @Test fun `restricted demo overview preserves the existing official Codex filter`() {
        val targets = listOf(snapshot("a", provider(), provider("codex", auth = "oauth"),
            provider("other", auth = "oauth").copy(agentType = "agy")))
        assertEquals(listOf("codex"), accountProviderGroups(targets, restrictedDemo = true).map { it.provider.id })
    }

    @Test fun `credential mismatch and missing comparison metadata never imply synchronized`() {
        assertFalse(accountProviderGroups(listOf(snapshot("a", provider()), snapshot("b", provider(fingerprint = "changed")))).single().configurationMatches)
        assertFalse(accountProviderGroups(listOf(snapshot("a", provider()), snapshot("b", provider(fingerprint = "")))).single().configurationMatches)
        assertFalse(accountProviderGroups(listOf(snapshot("a", provider()), snapshot("b", provider().copy(defaultModel = "other")))).single().configurationMatches)
        assertFalse(accountProviderGroups(listOf(snapshot("a", provider()), snapshot("b", provider().copy(quotaPolicyIdentity = "changed")))).single().configurationMatches)
    }

    private class Backend {
        val requests = mutableListOf<Pair<String, ApiRequest>>()
        var failB = false
        var failMutation = false
        var gate: CompletableDeferred<Unit>? = null
        var oauthComplete = false
        fun repository(id: String) = WebParityRepository { request ->
            requests += id to request
            if (id == "b" && failB) error("unreachable")
            if (request.method != "GET") {
                gate?.await()
                if (failMutation) error("write failed")
            }
            val body = when {
                request.path.startsWith("/api/native-provider-oauth/jobs") -> {
                    if (request.method == "DELETE") oauthComplete = true
                    """{"job":{"id":"job","agentType":"agy","state":"${if (oauthComplete) "completed" else "awaiting-input"}","requiresInput":${!oauthComplete}}}"""
                }
                request.path == "/api/native-providers" && request.method == "GET" ->
                    """{"providers":[{"id":"$id-p","syncId":"shared","displayName":"Shared","agentType":"codex","authType":"api-key","credentialOk":true,"credentialFingerprint":"fp","quota":null}]}"""
                request.path == "/api/harnesses" -> """{"harnesses":[{"id":"codex","name":"Codex","installed":true,"supportedOnPlatform":true}]}"""
                else -> "{}"
            }
            ApiResponse(200, body)
        }
        fun viewModel() = WebParityViewModel(repository("foreground"),
            providerInstancesProvider = { listOf(ProviderInstance("a", "Office"), ProviderInstance("b", "Studio")) },
            providerRepositoryFactory = ::repository)
    }

    @Test fun `partial failure stays unknown and does not hide reachable instances`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val backend = Backend().apply { failB = true }
            val vm = backend.viewModel()
            vm.onEvent(WebParityEvent.OpenPage(WebParityPage.ModelProviders)); advanceUntilIdle()
            assertEquals(listOf(true, false), vm.state.value.providerInstances.map { it.available })
            assertEquals(1, accountProviderGroups(vm.state.value.providerInstances).size)
            vm.onEvent(WebParityEvent.SelectProviderInstance("b")); advanceUntilIdle()
            backend.requests.clear()
            vm.onEvent(WebParityEvent.DeleteProvider("b-p")); advanceUntilIdle()
            assertTrue(backend.requests.isEmpty())
        } finally { Dispatchers.resetMain() }
    }

    @Test fun `create edit quota rotation and delete all use selected instance without foreground switching`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val backend = Backend(); val vm = backend.viewModel()
            vm.onEvent(WebParityEvent.OpenPage(WebParityPage.ModelProviders)); advanceUntilIdle()
            vm.onEvent(WebParityEvent.SelectProviderInstance("b")); advanceUntilIdle()
            backend.requests.clear()
            vm.onEvent(WebParityEvent.TargetChanged("unrelated-chat"))
            val actions = listOf(WebParityEvent.CreateProviderApiKey("codex", "New", "https://example.test", "test", "model", "responses"),
                WebParityEvent.UpdateProvider("b-p", "Edited", "https://example.test", "", "model", "responses", true),
                WebParityEvent.RefreshProviderQuota("b-p"), WebParityEvent.ToggleProviderRotation(true),
                WebParityEvent.ToggleProviderRotationProvider("b-p", true), WebParityEvent.DeleteProvider("b-p"))
            actions.forEach { vm.onEvent(it); advanceUntilIdle() }
            assertEquals(6, backend.requests.count { it.second.method != "GET" })
            assertTrue(backend.requests.filter { it.second.method != "GET" }.all { it.first == "b" })
            assertTrue(backend.requests.none { it.first == "foreground" })
            assertEquals("Studio", vm.state.value.providerSavedTarget)
        } finally { Dispatchers.resetMain() }
    }

    @Test fun `in flight write cannot be redirected and failure remains retryable on its original target`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val backend = Backend(); val vm = backend.viewModel()
            vm.onEvent(WebParityEvent.OpenPage(WebParityPage.ModelProviders)); advanceUntilIdle()
            vm.onEvent(WebParityEvent.SelectProviderInstance("b")); advanceUntilIdle()
            backend.gate = CompletableDeferred(); backend.failMutation = true
            vm.onEvent(WebParityEvent.DeleteProvider("b-p")); runCurrent()
            vm.onEvent(WebParityEvent.SelectProviderInstance("a"))
            vm.onEvent(WebParityEvent.TargetChanged("a"))
            assertEquals("b", vm.state.value.providerTargetId)
            backend.gate!!.complete(Unit); advanceUntilIdle()
            assertEquals("write failed", vm.state.value.error)
            assertNull(vm.state.value.providerSavedTarget)
            backend.failMutation = false
            vm.onEvent(WebParityEvent.DeleteProvider("b-p")); advanceUntilIdle()
            assertNull(vm.state.value.error)
            assertEquals("Studio", vm.state.value.providerSavedTarget)
        } finally { Dispatchers.resetMain() }
    }

    @Test fun `OAuth status input and cancellation remain on original instance`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val backend = Backend(); val vm = backend.viewModel()
            vm.onEvent(WebParityEvent.OpenPage(WebParityPage.ModelProviders)); advanceUntilIdle()
            vm.onEvent(WebParityEvent.SelectProviderInstance("b")); advanceUntilIdle()
            vm.onEvent(WebParityEvent.StartProviderOAuth("agy", "Login")); runCurrent()
            vm.onEvent(WebParityEvent.SelectProviderInstance("a"))
            vm.onEvent(WebParityEvent.TargetChanged("a"))
            vm.onEvent(WebParityEvent.SubmitProviderOAuthCredential("fixture-only")); runCurrent()
            vm.onEvent(WebParityEvent.CancelProviderOAuth); advanceUntilIdle()
            assertEquals("b", vm.state.value.providerTargetId)
            assertTrue(backend.requests.filter { it.second.path.contains("oauth/jobs") }.all { it.first == "b" })
            assertTrue(backend.requests.any { it.second.path.endsWith("/input") })
            assertEquals("completed", vm.state.value.providerOAuthJob?.state)
        } finally { Dispatchers.resetMain() }
    }

    @Test fun `overview never permits a mutation with an implicit target`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val backend = Backend(); val vm = backend.viewModel()
            vm.onEvent(WebParityEvent.OpenPage(WebParityPage.ModelProviders)); advanceUntilIdle()
            backend.requests.clear()
            vm.onEvent(WebParityEvent.DeleteProvider("a-p")); advanceUntilIdle()
            assertTrue(backend.requests.isEmpty())
        } finally { Dispatchers.resetMain() }
    }

    @Test fun `retry only reads failed instance and restores its configuration`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val backend = Backend().apply { failB = true }; val vm = backend.viewModel()
            vm.onEvent(WebParityEvent.OpenPage(WebParityPage.ModelProviders)); advanceUntilIdle()
            backend.requests.clear(); backend.failB = false
            vm.onEvent(WebParityEvent.RetryProviderInstance("b")); advanceUntilIdle()
            assertTrue(backend.requests.all { it.first == "b" })
            assertTrue(vm.state.value.providerInstances.all { it.available })
            assertEquals(2, accountProviderGroups(vm.state.value.providerInstances).single().copies.size)
        } finally { Dispatchers.resetMain() }
    }
}

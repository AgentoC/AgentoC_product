package com.andysagent.agentoc.feature.organization.data

import com.andysagent.agentoc.core.network.AgentoCTransport
import com.andysagent.agentoc.core.network.ApiRequest
import kotlinx.serialization.json.Json

interface OrganizationApi {
    suspend fun getProjection(organizationId: String, version: Int = 2, sinceEventId: Long = 0L): Result<OrganizationProjectionDto>
    suspend fun getSessionOrganization(sessionId: String): Result<OrganizationProjectionDto?>
}

class RealOrganizationApi(
    private val transport: AgentoCTransport,
    private val json: Json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        coerceInputValues = true
    },
) : OrganizationApi {

    override suspend fun getProjection(
        organizationId: String,
        version: Int,
        sinceEventId: Long,
    ): Result<OrganizationProjectionDto> = runCatching {
        val path = "/api/organizations/$organizationId/projection?version=$version&sinceEventId=$sinceEventId"
        val response = transport.execute(ApiRequest(method = "GET", path = path))
        if (!response.isSuccessful) {
            error("Failed to load organization projection: ${response.statusCode}")
        }
        json.decodeFromString<OrganizationProjectionDto>(response.body)
    }

    override suspend fun getSessionOrganization(
        sessionId: String,
    ): Result<OrganizationProjectionDto?> = runCatching {
        val path = "/api/sessions/$sessionId/organization/projection"
        val response = transport.execute(ApiRequest(method = "GET", path = path))
        if (response.statusCode == 404) return@runCatching null
        if (!response.isSuccessful) {
            error("Failed to load session organization projection: ${response.statusCode}")
        }
        json.decodeFromString<OrganizationProjectionDto>(response.body)
    }
}

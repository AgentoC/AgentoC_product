package com.andysagent.agentoc

import com.andysagent.agentoc.core.auth.AccountSessionException
import com.andysagent.agentoc.core.network.ApiException

/** Preserve the server cooldown when a rendezvous retry escapes to the outer loop. */
internal fun bootstrapRecoveryRetryDelayMs(error: Throwable, attempt: Int): Long {
    val fallback = bootstrapRetryDelayMs(attempt)
    val (status, hint) = when (error) {
        is AccountSessionException -> error.statusCode to error.retryAfterMs
        is ApiException -> error.statusCode to error.retryAfterMs
        else -> return fallback
    }
    if (status != 429) return fallback
    return maxOf(fallback, hint?.takeIf { it > 0L } ?: 5_000L)
}

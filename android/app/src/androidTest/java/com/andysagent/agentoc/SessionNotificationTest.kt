package com.andysagent.agentoc

import android.app.NotificationManager
import android.content.Context
import android.os.SystemClock
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.andysagent.agentoc.core.appapi.SessionNavigationRequest
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class SessionNotificationTest {
    @Test fun sourceAndHashCollisionSessionsHaveIndependentImmutablePendingIntentsAndTerminalCancellation() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val manager = context.getSystemService(NotificationManager::class.java)
        assertTrue("Host must grant notifications before instrumentation starts", manager.areNotificationsEnabled())
        val suffix = UUID.randomUUID().toString().take(8)
        val a = "qa-a-$suffix"; val b = "qa-b-$suffix"
        val requests = listOf(SessionNavigationRequest("Aa", a, "question", "q1"), SessionNavigationRequest("BB", a, "question", "q2"),
            SessionNavigationRequest("Aa", b, "question", "q1"))
        val publisher = AgentoCFirebaseMessagingService.Publisher(context)
        fun publish(r: SessionNavigationRequest) = publisher.publish(mapOf("notificationContractVersion" to "1", "instanceId" to r.targetInstanceId!!,
            "sessionId" to r.sessionId, "kind" to r.kind, "awaitingKey" to r.awaitingKey), "Synthetic QA", "Synthetic notification")
        val completion = requests[0].copy(kind = "completion", awaitingKey = "")
        val ownedTags = (requests + completion).map(SessionNavigationRequest::identity).toSet()
        fun awaitPostedTags(expected: Set<String>) {
            // NotificationManager's cancel/notify calls enqueue work in system_server.
            // Observe the actual system state before asserting its final membership.
            val started = SystemClock.elapsedRealtime()
            var actual: Set<String>
            do {
                actual = manager.activeNotifications.mapNotNull { it.tag }.filter { it in ownedTags }.toSet()
                if (actual == expected) break
                SystemClock.sleep(25)
            } while (SystemClock.elapsedRealtime() - started < 5_000)
            Log.i("SessionNotificationTest", "System notification reconciliation: ${SystemClock.elapsedRealtime() - started} ms")
            assertEquals(expected, actual)
        }
        try {
            requests.forEach(::publish)
            awaitPostedTags(requests.map(SessionNavigationRequest::identity).toSet())
            val posted = manager.activeNotifications.filter { it.tag in requests.map(SessionNavigationRequest::identity) }
            assertEquals(3, posted.size)
            assertEquals(3, posted.map { it.notification.contentIntent }.distinct().size)
            if (android.os.Build.VERSION.SDK_INT >= 31) assertTrue(posted.all { it.notification.contentIntent.isImmutable })
            requests.forEach(::publish)
            awaitPostedTags(requests.map(SessionNavigationRequest::identity).toSet())
            assertEquals(3, manager.activeNotifications.count { it.tag in requests.map(SessionNavigationRequest::identity) })
            publish(completion)
            awaitPostedTags(setOf(requests[1].identity(), requests[2].identity(), completion.identity()))
            val tags = manager.activeNotifications.map { it.tag }
            assertFalse(requests[0].identity() in tags)
            assertTrue(requests[1].identity() in tags); assertTrue(requests[2].identity() in tags)
            assertTrue(completion.identity() in tags)
        } finally {
            (requests + completion).forEach { manager.cancel(it.identity(), 1) }
        }
    }
}

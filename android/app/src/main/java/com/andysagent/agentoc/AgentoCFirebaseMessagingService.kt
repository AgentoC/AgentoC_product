package com.andysagent.agentoc

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import com.andysagent.agentoc.core.appapi.SessionNavigationRequest

class AgentoCFirebaseMessagingService : FirebaseMessagingService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onNewToken(token: String) {
        scope.launch {
            runCatching { (application as AgentoCApplication).runtime.registerFcmToken(token) }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val title = message.notification?.title ?: data["title"] ?: "AgentoC"
        val body = message.notification?.body ?: data["body"] ?: "AgentoC needs your attention"
        Publisher(this).publish(data, title, body)
    }

    internal class Publisher(private val context: Context) {
        fun publish(data: Map<String, String>, title: String, body: String) {
            val kind = data["kind"].orEmpty()
            val awaitingKey = data["awaitingKey"].orEmpty()
            val eventId = data["eventId"].orEmpty()
            val sessionId = data["sessionId"].orEmpty()
            val version = data["notificationContractVersion"]
            if (version != null && version != "1") return
            val target = data["instanceId"]
            if (version != null && target.isNullOrEmpty()) return
            val request = runCatching { SessionNavigationRequest(sessionId, target, kind, awaitingKey, eventId).validated() }.getOrNull() ?: return
            val channelId = channelFor(kind)
            val intent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                action = Intent.ACTION_VIEW
                setData(Uri.parse("agentoc-internal://notification/${request.identity()}"))
                putExtra(EXTRA_NOTIFICATION_SESSION_ID, sessionId)
                putExtra(EXTRA_NOTIFICATION_INSTANCE_ID, target)
                putExtra(EXTRA_NOTIFICATION_VERSION, version)
                putExtra(EXTRA_NOTIFICATION_KIND, kind)
                putExtra(EXTRA_NOTIFICATION_AWAITING_KEY, awaitingKey)
                putExtra(EXTRA_NOTIFICATION_EVENT_ID, eventId)
            }
            val identity = request.identity()
            val pendingIntent = PendingIntent.getActivity(
                context,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            ensureChannel(channelId)
            val notification = NotificationCompat.Builder(context, channelId)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)
                .addExtras(Bundle().apply {
                    putString(EXTRA_NOTIFICATION_INSTANCE_ID, target)
                    putString(EXTRA_NOTIFICATION_SESSION_ID, sessionId)
                })
                .build()
            // A terminal event for a session supersedes its "waiting for you"
            // notification: keeping both would advertise a decision that no
            // longer exists.
            if (kind == "completion" || kind == "failure") {
                // Clear only this source PC/session's attention, including distinct questions/approvals.
                context.getSystemService(NotificationManager::class.java).activeNotifications
                    .filter { it.notification.channelId == ATTENTION_CHANNEL_ID &&
                        it.notification.extras.getString(EXTRA_NOTIFICATION_INSTANCE_ID) == target &&
                        it.notification.extras.getString(EXTRA_NOTIFICATION_SESSION_ID) == sessionId }
                    .forEach { NotificationManagerCompat.from(context).cancel(it.tag, it.id) }
            }
            if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
            try {
                NotificationManagerCompat.from(context).notify(identity, 1, notification)
            } catch (_: SecurityException) {
                // Permission can be revoked between the check and publication.
            }
        }

        private fun ensureChannel(channelId: String) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(
                    channelId,
                    if (channelId == ATTENTION_CHANNEL_ID) "Needs attention" else "Run updates",
                    if (channelId == ATTENTION_CHANNEL_ID) NotificationManager.IMPORTANCE_HIGH else NotificationManager.IMPORTANCE_DEFAULT,
                ),
            )
        }

        private fun channelFor(kind: String?): String =
            if (kind in setOf("attention", "approval", "question", "plan", "danger", "answer", "permission")) ATTENTION_CHANNEL_ID
            else RUN_CHANNEL_ID
    }

    companion object {
        const val RUN_CHANNEL_ID = "agentoc-run-events"
        const val ATTENTION_CHANNEL_ID = "agentoc-attention"
        const val EXTRA_NOTIFICATION_SESSION_ID = "notification_session_id"
        const val EXTRA_NOTIFICATION_KIND = "notification_kind"
        const val EXTRA_NOTIFICATION_AWAITING_KEY = "notification_awaiting_key"
        const val EXTRA_NOTIFICATION_EVENT_ID = "notification_event_id"
        const val EXTRA_NOTIFICATION_INSTANCE_ID = "notification_instance_id"
        const val EXTRA_NOTIFICATION_VERSION = "notification_contract_version"

        /**
         * Source-bound identity; event IDs remain scoped to the source PC and session.
         * Legacy source-less notifications are isolated and require explicit target choice.
         */
        fun notificationIdentity(
            sessionId: String,
            kind: String?,
            awaitingKey: String?,
            eventId: String?,
            targetInstanceId: String? = null,
        ): String {
            return SessionNavigationRequest(sessionId, targetInstanceId, kind.orEmpty(), awaitingKey.orEmpty(), eventId.orEmpty()).identity()
        }
    }
}

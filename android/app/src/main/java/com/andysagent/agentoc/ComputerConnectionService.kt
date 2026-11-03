package com.andysagent.agentoc

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/** Keeps the process hosting the active computer carrier visible to Android. */
internal class ComputerConnectionService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.computer_connection_channel), NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle(getString(R.string.computer_connection_title))
            .setContentText(getString(R.string.computer_connection_description))
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).build()
        if (Build.VERSION.SDK_INT >= 29) {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else startForeground(NOTIFICATION_ID, notification)
        return START_NOT_STICKY
    }

    companion object {
        private const val CHANNEL = "agentoc.computer.connection"
        private const val NOTIFICATION_ID = 0x41474343

        fun startWhileVisible(context: Context) {
            try { ContextCompat.startForegroundService(context, Intent(context, ComputerConnectionService::class.java)) }
            catch (error: Exception) { android.util.Log.w("AgentoCRuntime", "Background computer connection service unavailable", error) }
        }

        fun stop(context: Context) { context.stopService(Intent(context, ComputerConnectionService::class.java)) }
    }
}

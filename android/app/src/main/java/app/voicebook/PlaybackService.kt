package app.voicebook

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Keeps Voicebook running while it reads with the screen off: a foreground service with
 * a "now reading" notification (with a pause/play button) and a CPU wake lock, so the
 * page keeps playing and the native voice keeps preparing the next passages.
 */
class PlaybackService : Service() {
    companion object {
        const val CHANNEL = "reading"
        const val ACTION_TOGGLE = "app.voicebook.TOGGLE"
        private const val ID = 7

        fun update(ctx: Context, playing: Boolean, title: String, subtitle: String) {
            val i = Intent(ctx, PlaybackService::class.java)
                .putExtra("playing", playing).putExtra("title", title).putExtra("subtitle", subtitle)
            try {
                if (playing) ctx.startForegroundService(i) else ctx.startService(i)
            } catch (_: Throwable) {
                // Not allowed right now (e.g. started from the background): reading continues anyway.
            }
        }
    }

    private var wake: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val playing = intent?.getBooleanExtra("playing", false) ?: false
        val title = intent?.getStringExtra("title")?.takeIf { it.isNotBlank() } ?: "Voicebook"
        val subtitle = intent?.getStringExtra("subtitle") ?: ""
        if (!playing) {
            // Paused or stopped: let the phone sleep and remove the notification.
            wake?.let { if (it.isHeld) it.release() }
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        val n = notification(title, subtitle, true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        else startForeground(ID, n)
        if (wake == null) {
            wake = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Voicebook:reading").apply { setReferenceCounted(false) }
        }
        wake?.acquire(4 * 60 * 60 * 1000L)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        wake?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }

    private fun notification(title: String, subtitle: String, playing: Boolean): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Reading", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while Voicebook reads"
                setShowBadge(false)
            })
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val toggle = PendingIntent.getBroadcast(
            this, 1, Intent(ACTION_TOGGLE).setPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        @Suppress("DEPRECATION")
        val action = Notification.Action.Builder(
            if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
            if (playing) "Pause" else "Play", toggle,
        ).build()
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(subtitle.ifBlank { if (playing) "Reading…" else "Paused" })
            .setContentIntent(open)
            .setOngoing(playing)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(action)
            .setStyle(Notification.MediaStyle().setShowActionsInCompactView(0))
            .build()
    }
}

package app.voicebook

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Voicebook as a normal media player: a media session (lock screen, quick settings player,
 * headset and Bluetooth buttons, Android Auto-style controls) with a media notification
 * (previous · play/pause · next), plus a foreground service and CPU wake lock while it
 * reads, so the page keeps playing and the phone voice keeps preparing with the screen off.
 * Paused, the player stays on the lock screen (like any music app) but lets the phone sleep.
 */
class PlaybackService : Service() {
    companion object {
        const val CHANNEL = "reading"
        /** Broadcast to the app's page: extra "cmd" = play | pause | toggle | next | previous | back | forward */
        const val ACTION_TOGGLE = "app.voicebook.TOGGLE"
        private const val ACTION_CMD = "app.voicebook.CMD"
        private const val ACTION_DISMISS = "app.voicebook.DISMISS"
        private const val ID = 7

        fun update(ctx: Context, playing: Boolean, title: String, subtitle: String, progress: Double = -1.0) {
            val i = Intent(ctx, PlaybackService::class.java)
                .putExtra("playing", playing).putExtra("title", title).putExtra("subtitle", subtitle)
                .putExtra("progress", progress)
            try {
                if (playing) ctx.startForegroundService(i) else ctx.startService(i)
            } catch (_: Throwable) {
                // Not allowed right now (e.g. started from the background): reading continues anyway.
            }
        }
    }

    private var wake: PowerManager.WakeLock? = null
    private var session: MediaSession? = null
    private var art: Bitmap? = null
    private var playing = false
    private var title = "Voicebook"
    private var subtitle = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        art = try { BitmapFactory.decodeResource(resources, R.mipmap.ic_launcher) } catch (_: Throwable) { null }
        session = MediaSession(this, "Voicebook").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = send("play")
                override fun onPause() = send("pause")
                override fun onStop() = send("pause")
                override fun onSkipToNext() = send("next")
                override fun onSkipToPrevious() = send("previous")
                override fun onFastForward() = send("next")
                override fun onRewind() = send("previous")
            })
            setSessionActivity(openApp())
            isActive = true
        }
    }

    /** Tell the page (MainActivity forwards it to the reader). */
    private fun send(cmd: String) {
        sendBroadcast(Intent(ACTION_TOGGLE).setPackage(packageName).putExtra("cmd", cmd))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_CMD -> { send(intent.getStringExtra("cmd") ?: "toggle"); return START_NOT_STICKY }
            ACTION_DISMISS -> { shutDown(); return START_NOT_STICKY }
        }
        if (intent == null) return START_NOT_STICKY
        playing = intent.getBooleanExtra("playing", false)
        title = intent.getStringExtra("title")?.takeIf { it.isNotBlank() } ?: "Voicebook"
        subtitle = intent.getStringExtra("subtitle") ?: ""
        val progress = intent.getDoubleExtra("progress", -1.0)
        publish(progress)
        val n = notification()
        if (playing) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            else startForeground(ID, n)
            if (wake == null) {
                wake = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Voicebook:reading").apply { setReferenceCounted(false) }
            }
            wake?.acquire(4 * 60 * 60 * 1000L)
        } else {
            // Paused: the phone may sleep, but the player stays on the lock screen to resume.
            wake?.let { if (it.isHeld) it.release() }
            stopForeground(STOP_FOREGROUND_DETACH)
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(ID, n)
        }
        return START_NOT_STICKY
    }

    /** What the lock screen and the quick settings player show. */
    private fun publish(progress: Double) {
        val s = session ?: return
        val meta = MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, subtitle.ifBlank { title })
            .putString(MediaMetadata.METADATA_KEY_ARTIST, title)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, "Voicebook")
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, subtitle.ifBlank { title })
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, title)
        // Progress through the book, shown as a 0–100 "minute" bar on players that draw one.
        if (progress >= 0) meta.putLong(MediaMetadata.METADATA_KEY_DURATION, 100_000L)
        art?.let { meta.putBitmap(MediaMetadata.METADATA_KEY_ART, it).putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, it) }
        s.setMetadata(meta.build())
        s.setPlaybackState(
            PlaybackState.Builder()
                .setActions(
                    PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
                        PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or
                        PlaybackState.ACTION_STOP or PlaybackState.ACTION_FAST_FORWARD or PlaybackState.ACTION_REWIND,
                )
                .setState(
                    if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                    if (progress >= 0) (progress.coerceIn(0.0, 1.0) * 100_000).toLong() else PlaybackState.PLAYBACK_POSITION_UNKNOWN,
                    if (playing) 1f else 0f,
                )
                .build(),
        )
        if (!s.isActive) s.isActive = true
    }

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun cmd(code: Int, cmd: String): PendingIntent = PendingIntent.getService(
        this, code, Intent(this, PlaybackService::class.java).setAction(ACTION_CMD).putExtra("cmd", cmd),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun notification(): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Reading", NotificationManager.IMPORTANCE_LOW).apply {
                description = "The player shown while Voicebook reads"
                setShowBadge(false)
            })
        }
        @Suppress("DEPRECATION")
        fun action(icon: Int, label: String, pi: PendingIntent) = Notification.Action.Builder(icon, label, pi).build()
        val dismiss = PendingIntent.getService(
            this, 9, Intent(this, PlaybackService::class.java).setAction(ACTION_DISMISS),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setLargeIcon(art)
            .setContentTitle(subtitle.ifBlank { title })
            .setContentText(if (subtitle.isBlank()) (if (playing) "Reading…" else "Paused") else title)
            .setContentIntent(openApp())
            .setDeleteIntent(dismiss)
            .setOngoing(playing)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(action(android.R.drawable.ic_media_previous, "Previous", cmd(2, "previous")))
            .addAction(
                if (playing) action(android.R.drawable.ic_media_pause, "Pause", cmd(3, "pause"))
                else action(android.R.drawable.ic_media_play, "Play", cmd(3, "play")),
            )
            .addAction(action(android.R.drawable.ic_media_next, "Next", cmd(4, "next")))
            .setStyle(Notification.MediaStyle().setMediaSession(session?.sessionToken).setShowActionsInCompactView(0, 1, 2))
            .build()
    }

    /** The player was swiped away while paused: close it fully. */
    private fun shutDown() {
        wake?.let { if (it.isHeld) it.release() }
        session?.isActive = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        wake?.let { if (it.isHeld) it.release() }
        session?.release()
        session = null
        super.onDestroy()
    }
}

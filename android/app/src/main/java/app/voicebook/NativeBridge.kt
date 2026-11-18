package app.voicebook

import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebResourceResponse
import android.webkit.WebView
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * What the web app can ask of the phone, as `window.VBNative`. Results come back as
 * events: `window.__vbNativeEvent(type, data)`. Generated audio is served to the page at
 * `/__native/audio/<id>.wav` (same origin as the page, so no CORS questions).
 */
class NativeBridge(private val act: MainActivity, private val web: WebView) {
    /** One engine and one set of worker threads for the whole app, even if the screen is rebuilt. */
    companion object {
        @Volatile private var shared: VoiceEngine? = null
        private val speakQueue = Executors.newSingleThreadExecutor()
        private val downloads = Executors.newSingleThreadExecutor()
        private val audio = ConcurrentHashMap<String, File>()
        fun engine(ctx: android.content.Context): VoiceEngine =
            shared ?: synchronized(this) { shared ?: VoiceEngine(ctx.applicationContext).also { shared = it } }
    }

    val engine = engine(act)
    private val outDir = File(act.cacheDir, "speech").apply { mkdirs() }

    private fun emit(type: String, data: JSONObject) {
        val js = "window.__vbNativeEvent && window.__vbNativeEvent(${JSONObject.quote(type)}, $data)"
        web.post { web.evaluateJavascript(js, null) }
    }

    @JavascriptInterface
    fun info(): String = JSONObject().apply {
        put("version", BuildConfig.VERSION_NAME)
        put("versionCode", BuildConfig.VERSION_CODE)
        put("cores", engine.cores)
        put("threads", engine.threads)
        put("memoryMb", engine.memoryMb)
        put("tiers", engine.status())
    }.toString()

    @JavascriptInterface
    fun download(tier: String) {
        downloads.execute {
            try {
                engine.download(tier) { p -> emit("progress", JSONObject().put("tier", tier).put("progress", p)) }
                emit("downloaded", JSONObject().put("tier", tier))
            } catch (e: Throwable) {
                Log.e(VoiceEngine.TAG, "download failed", e)
                emit("downloadError", JSONObject().put("tier", tier).put("error", e.message ?: e.toString()))
            }
        }
    }

    @JavascriptInterface
    fun remove(tier: String) {
        downloads.execute { engine.remove(tier); emit("removed", JSONObject().put("tier", tier)) }
    }

    @JavascriptInterface
    fun speak(id: String, tier: String, text: String, sid: Int, speed: Double) {
        speakQueue.execute {
            try {
                val f = File(outDir, "$id.wav")
                val seconds = engine.speak(tier, text, sid, speed.toFloat(), f)
                audio[id] = f
                emit("result", JSONObject().put("id", id).put("url", "/__native/audio/$id.wav").put("seconds", seconds))
            } catch (e: Throwable) {
                Log.e(VoiceEngine.TAG, "speak failed", e)
                emit("result", JSONObject().put("id", id).put("error", e.message ?: e.toString()))
            }
        }
    }

    /** Reading started/stopped: keeps the app running with the screen off (foreground service). */
    @JavascriptInterface
    fun setPlaying(playing: Boolean, title: String, subtitle: String) {
        act.runOnUiThread { PlaybackService.update(act, playing, title, subtitle) }
    }

    @JavascriptInterface
    fun openExternal(url: String) {
        act.runOnUiThread { act.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
    }

    /** Serves generated audio to the page. */
    fun intercept(url: Uri): WebResourceResponse? {
        val path = url.path ?: return null
        if (!path.startsWith("/__native/audio/")) return null
        val id = path.removePrefix("/__native/audio/").removeSuffix(".wav")
        val f = audio.remove(id)
        val headers = mapOf("Cache-Control" to "no-store", "Cross-Origin-Resource-Policy" to "same-origin")
        if (f == null || !f.exists()) return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, "missing".byteInputStream())
        // The file is read once; it is deleted when the next app start clears the folder.
        return WebResourceResponse("audio/wav", null, 200, "OK", headers, FileInputStream(f))
    }

    /** Started by the build server's emulator test: download the fast voice and speak a sentence. */
    fun selfTest() {
        downloads.execute {
            try {
                Log.i("VBTEST", "start: ${engine.cores} cores, ${engine.memoryMb} MB")
                val t0 = System.currentTimeMillis()
                engine.download("fast") { p -> Log.i("VBTEST", "download ${(p * 100).toInt()}%") }
                Log.i("VBTEST", "downloaded in ${(System.currentTimeMillis() - t0) / 1000} s")
                val out = File(act.getExternalFilesDir(null) ?: act.filesDir, "selftest.wav")
                val t1 = System.currentTimeMillis()
                val seconds = engine.speak("fast", "The storm had been building since noon, and by the time Elena reached the lighthouse, the sea was throwing itself against the rocks. Dr. Smith paid \$3.50 at 7:05.", 3, 1.0f, out)
                val took = (System.currentTimeMillis() - t1) / 1000.0
                Log.i("VBTEST", "spoke %.1f s of audio in %.1f s -> ${out.absolutePath}".format(seconds, took))
                Log.i("VBTEST", "done ok")
            } catch (e: Throwable) {
                Log.e("VBTEST", "failed", e)
                Log.i("VBTEST", "done failed: ${e.message}")
            }
        }
    }
}

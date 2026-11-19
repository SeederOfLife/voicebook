package app.voicebook

import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
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
        private val scanQueue = Executors.newSingleThreadExecutor()
        /** Books found on the phone: id → document address (read when the page asks for it). */
        private val found = ConcurrentHashMap<String, Uri>()
        private val BOOK = Regex("""\.(pdf|epub|txt|md|markdown|html?)$""", RegexOption.IGNORE_CASE)
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

    /** Download the newer app and open Android's install screen (one tap, keeps everything). */
    @JavascriptInterface
    fun installUpdate(url: String) {
        downloads.execute {
            try {
                val dir = File(act.cacheDir, "updates").apply { mkdirs(); listFiles()?.forEach { it.delete() } }
                val apk = File(dir, "voicebook-update.apk")
                val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                conn.connectTimeout = 20000
                conn.readTimeout = 60000
                if (conn.responseCode != 200) throw RuntimeException("download failed (HTTP ${conn.responseCode})")
                val total = conn.contentLengthLong.coerceAtLeast(1)
                var got = 0L
                var last = 0L
                conn.inputStream.use { input ->
                    java.io.FileOutputStream(apk).use { out ->
                        val buf = ByteArray(1 shl 16)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            got += n
                            val now = System.currentTimeMillis()
                            if (now - last > 300) { last = now; emit("updateProgress", JSONObject().put("progress", got.toDouble() / total)) }
                        }
                    }
                }
                emit("updateProgress", JSONObject().put("progress", 1.0))
                val uri = androidx.core.content.FileProvider.getUriForFile(act, act.packageName + ".files", apk)
                act.runOnUiThread {
                    act.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            } catch (e: Throwable) {
                Log.e(VoiceEngine.TAG, "update failed", e)
                emit("updateError", JSONObject().put("error", e.message ?: e.toString()))
            }
        }
    }

    // ---------- Storage & speed ----------

    /** What Voicebook takes on this phone, and the phone's free space. */
    @JavascriptInterface
    fun storageInfo(): String {
        val dataDir = act.filesDir.parentFile ?: act.filesDir
        val cache = act.cacheDir.walkTopDown().filter { it.isFile }.sumOf { it.length() }
        val stat = android.os.StatFs(act.filesDir.absolutePath)
        val pm = act.getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
        val rt = Runtime.getRuntime()
        val am = act.getSystemService(android.content.Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        val mem = android.app.ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        return JSONObject().apply {
            put("voicesBytes", engine.sizeOnDisk())
            put("cacheBytes", cache)
            put("appDataBytes", dataDir.walkTopDown().filter { it.isFile }.sumOf { it.length() })
            put("freeBytes", stat.availableBytes)
            put("totalBytes", stat.totalBytes)
            put("phoneMemoryFreeMb", mem.availMem / (1024 * 1024))
            put("phoneMemoryLow", mem.lowMemory)
            put("appMemoryMb", (rt.totalMemory() - rt.freeMemory()) / (1024 * 1024))
            put("backgroundAllowed", pm.isIgnoringBatteryOptimizations(act.packageName))
        }.toString()
    }

    /** Temporary files only (speech being played, downloaded updates). Books and voices stay. */
    @JavascriptInterface
    fun clearCache() {
        downloads.execute {
            act.cacheDir.listFiles()?.forEach { it.deleteRecursively() }
            File(act.cacheDir, "speech").mkdirs()
            act.runOnUiThread { web.clearCache(false) }
            emit("cleaned", JSONObject())
        }
    }

    /** Free memory: close the voice model and ask the page's engine to drop what it can. */
    @JavascriptInterface
    fun freeMemory() {
        speakQueue.execute {
            engine.release()
            System.gc()
            emit("cleaned", JSONObject())
        }
    }

    /** Ask Android to let Voicebook keep working in the background (Android shows a yes/no). */
    @JavascriptInterface
    fun allowBackground() {
        act.runOnUiThread {
            try {
                act.startActivity(Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${act.packageName}")))
            } catch (_: Throwable) {
                act.startActivity(Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            }
        }
    }

    /** Android's own storage screen ("Free up space") for the rest of the phone. */
    @JavascriptInterface
    fun openStorageSettings() {
        act.runOnUiThread {
            try {
                act.startActivity(Intent(android.provider.Settings.ACTION_INTERNAL_STORAGE_SETTINGS))
            } catch (_: Throwable) {
                act.startActivity(Intent(android.provider.Settings.ACTION_SETTINGS))
            }
        }
    }

    @JavascriptInterface
    fun openExternal(url: String) {
        act.runOnUiThread { act.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
    }

    /** Choose a folder on the phone (Download, Books…) and look for books in it. */
    @JavascriptInterface
    fun scanFolder() {
        act.runOnUiThread { act.pickFolder() }
    }

    /** Look again in every folder chosen before, or the whole phone if allowed (new books since last time). */
    @JavascriptInterface
    fun rescan() {
        if (act.hasAllFilesAccess()) { scanPhoneNow(true); return }
        val trees = act.contentResolver.persistedUriPermissions.filter { it.isReadPermission }.map { it.uri }
        if (trees.isNotEmpty()) scan(trees, true)
    }

    /** Whole phone: asks for "all files" access first (one switch in Android settings). */
    @JavascriptInterface
    fun scanPhone() {
        act.runOnUiThread {
            if (act.hasAllFilesAccess()) scanPhoneNow(false) else act.askAllFilesAccess()
        }
    }

    @JavascriptInterface
    fun hasAllFiles(): Boolean = act.hasAllFilesAccess()

    fun scanPhoneNow(auto: Boolean) {
        scanQueue.execute {
            val root = android.os.Environment.getExternalStorageDirectory()
            val files = org.json.JSONArray()
            try {
                walkFiles(root, root, 0, files)
            } catch (e: Throwable) {
                Log.w(VoiceEngine.TAG, "phone scan failed", e)
            }
            emit("scan", JSONObject().put("auto", auto).put("folders", org.json.JSONArray().put("this phone")).put("files", files))
        }
    }

    private fun walkFiles(root: File, dir: File, depth: Int, out: org.json.JSONArray) {
        if (out.length() >= 5000) return
        val list = dir.listFiles() ?: return
        for (f in list.sortedBy { it.name.lowercase() }) {
            if (f.name.startsWith(".")) continue
            if (f.isDirectory) {
                if (depth < 10 && !(depth == 0 && f.name == "Android")) walkFiles(root, f, depth + 1, out)
            } else if (BOOK.containsMatchIn(f.name) && f.length() > 0) {
                val key = "p" + Integer.toHexString(f.absolutePath.hashCode())
                found[key] = Uri.fromFile(f)
                val folder = f.parentFile?.relativeTo(root)?.path?.ifBlank { "Phone" } ?: "Phone"
                out.put(JSONObject().put("id", key).put("name", f.name).put("size", f.length())
                    .put("modified", f.lastModified()).put("folder", folder))
            }
        }
    }

    @JavascriptInterface
    fun forgetFolders() {
        for (p in act.contentResolver.persistedUriPermissions) {
            try { act.contentResolver.releasePersistableUriPermission(p.uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Throwable) {}
        }
    }

    private fun folderName(tree: Uri): String =
        DocumentsContract.getTreeDocumentId(tree).substringAfterLast(':').substringAfterLast('/').ifBlank { "Phone" }

    fun scan(trees: List<Uri>, auto: Boolean) {
        scanQueue.execute {
            val files = org.json.JSONArray()
            val folders = org.json.JSONArray()
            for (tree in trees) {
                val top = folderName(tree)
                folders.put(top)
                try {
                    walk(tree, DocumentsContract.getTreeDocumentId(tree), top, 0, files)
                } catch (e: Throwable) {
                    Log.w(VoiceEngine.TAG, "scan failed for $tree", e)
                }
            }
            emit("scan", JSONObject().put("auto", auto).put("folders", folders).put("files", files))
        }
    }

    private fun walk(tree: Uri, docId: String, folder: String, depth: Int, out: org.json.JSONArray) {
        if (out.length() >= 3000) return
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
        val cols = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        act.contentResolver.query(children, cols, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                val id = c.getString(0) ?: continue
                val name = c.getString(1) ?: continue
                val mime = c.getString(2) ?: ""
                if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                    if (depth < 6 && !name.startsWith(".") && name != "Android") walk(tree, id, "$folder/$name", depth + 1, out)
                } else if (BOOK.containsMatchIn(name) && !name.startsWith(".")) {
                    val key = "f" + Integer.toHexString((tree.toString() + id).hashCode())
                    found[key] = DocumentsContract.buildDocumentUriUsingTree(tree, id)
                    out.put(JSONObject().put("id", key).put("name", name).put("size", if (c.isNull(3)) 0 else c.getLong(3))
                        .put("modified", if (c.isNull(4)) 0 else c.getLong(4)).put("folder", folder))
                }
            }
        }
    }

    /** Serves generated audio and books found on the phone to the page. */
    fun intercept(url: Uri): WebResourceResponse? {
        val path = url.path ?: return null
        if (path.startsWith("/__native/file/")) {
            val uri = found[path.removePrefix("/__native/file/")]
            val headers = mapOf("Cache-Control" to "no-store", "Cross-Origin-Resource-Policy" to "same-origin")
            return try {
                val input = uri?.let { act.contentResolver.openInputStream(it) } ?: throw IllegalStateException("not found")
                WebResourceResponse("application/octet-stream", null, 200, "OK", headers, input)
            } catch (e: Throwable) {
                WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, "missing".byteInputStream())
            }
        }
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

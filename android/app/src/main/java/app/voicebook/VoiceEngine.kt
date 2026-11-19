package app.voicebook

import android.app.ActivityManager
import android.content.Context
import android.util.Log
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.FilterInputStream
import java.io.InputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * The studio voice (Kokoro v1.0) running natively on the phone's processor, on several
 * cores, through sherpa-onnx. Two sizes: "fast" (8-bit, 132 MB) and "best" (full
 * precision, 350 MB). The model is downloaded once from sherpa-onnx's GitHub release.
 */
class VoiceEngine(private val ctx: Context) {
    data class Tier(val id: String, val pkg: String, val model: String, val mb: Int)

    companion object {
        const val TAG = "Voicebook"
        val TIERS = mapOf(
            "fast" to Tier("fast", "kokoro-int8-multi-lang-v1_0", "model.int8.onnx", 132),
            "best" to Tier("best", "kokoro-multi-lang-v1_0", "model.onnx", 350),
        )
        private const val BASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"
    }

    private val root = File(ctx.filesDir, "voices")
    private var tts: OfflineTts? = null
    private var ttsTier = ""
    @Volatile var downloading: String? = null
    @Volatile var progress = 0.0

    val cores: Int = Runtime.getRuntime().availableProcessors()
    val threads: Int = (cores - 2).coerceIn(1, 4)

    val memoryMb: Long
        get() {
            val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val info = ActivityManager.MemoryInfo()
            am.getMemoryInfo(info)
            return info.totalMem / (1024 * 1024)
        }

    private fun dir(t: Tier) = File(root, t.pkg)
    fun isReady(id: String): Boolean = TIERS[id]?.let { File(dir(it), ".complete").exists() } ?: false

    fun status(): JSONObject {
        val o = JSONObject()
        for ((id, t) in TIERS) {
            o.put(id, JSONObject().apply {
                put("ready", isReady(id))
                put("mb", t.mb)
                put("downloading", downloading == id)
                put("progress", if (downloading == id) progress else if (isReady(id)) 1.0 else 0.0)
            })
        }
        return o
    }

    private class Counting(input: InputStream, val onRead: (Long) -> Unit) : FilterInputStream(input) {
        var count = 0L
        override fun read(): Int {
            val b = super.read()
            if (b >= 0) onRead(++count)
            return b
        }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            val n = super.read(b, off, len)
            if (n > 0) { count += n; onRead(count) }
            return n
        }
    }

    /** Download and unpack one size (only the files the English voices need). */
    @Synchronized
    fun download(id: String, onProgress: (Double) -> Unit) {
        val t = TIERS[id] ?: throw IllegalArgumentException("unknown size $id")
        if (isReady(id)) { onProgress(1.0); return }
        downloading = id
        progress = 0.0
        try {
            val tmp = File(root, ".tmp-${t.pkg}")
            tmp.deleteRecursively()
            tmp.mkdirs()
            var url = URL(BASE + t.pkg + ".tar.bz2")
            var conn: HttpURLConnection
            var hops = 0
            while (true) {
                conn = url.openConnection() as HttpURLConnection
                conn.instanceFollowRedirects = false
                conn.connectTimeout = 20000
                conn.readTimeout = 60000
                val code = conn.responseCode
                if (code in 300..399 && hops++ < 5) {
                    url = URL(url, conn.getHeaderField("Location"))
                    conn.disconnect()
                    continue
                }
                if (code != 200) throw RuntimeException("download failed (HTTP $code)")
                break
            }
            val total = conn.contentLengthLong.takeIf { it > 0 } ?: (t.mb * 1_000_000L)
            var lastReport = 0L
            val counting = Counting(BufferedInputStream(conn.inputStream, 1 shl 16)) { n ->
                progress = min(0.99, n.toDouble() / total)
                val now = System.currentTimeMillis()
                if (now - lastReport > 400) { lastReport = now; onProgress(progress) }
            }
            val prefix = t.pkg + "/"
            TarArchiveInputStream(BZip2CompressorInputStream(counting)).use { tar ->
                var e = tar.nextEntry
                val buf = ByteArray(1 shl 16)
                while (e != null) {
                    val name = e.name.removePrefix("./").removePrefix(prefix)
                    val wanted = name == t.model || name == "voices.bin" || name == "tokens.txt" ||
                        name == "lexicon-us-en.txt" || name == "lexicon-gb-en.txt" || name.startsWith("espeak-ng-data/")
                    if (wanted && !name.contains("..")) {
                        val out = File(tmp, name)
                        if (e.isDirectory) out.mkdirs()
                        else {
                            out.parentFile?.mkdirs()
                            FileOutputStream(out).use { o ->
                                while (true) {
                                    val n = tar.read(buf)
                                    if (n < 0) break
                                    o.write(buf, 0, n)
                                }
                            }
                        }
                    }
                    e = tar.nextEntry
                }
            }
            conn.disconnect()
            if (!File(tmp, t.model).exists() || !File(tmp, "voices.bin").exists()) throw RuntimeException("the download was incomplete")
            File(tmp, ".complete").writeText("ok")
            val final = dir(t)
            final.deleteRecursively()
            if (!tmp.renameTo(final)) throw RuntimeException("could not store the voice")
            progress = 1.0
            onProgress(1.0)
        } finally {
            downloading = null
        }
    }

    /** Let go of the voice model in memory (it opens again when needed). */
    @Synchronized
    fun release() {
        tts?.release()
        tts = null
        ttsTier = ""
    }

    fun sizeOnDisk(): Long = root.walkTopDown().filter { it.isFile }.sumOf { it.length() }

    @Synchronized
    fun remove(id: String) {
        val t = TIERS[id] ?: return
        if (ttsTier == id) { tts?.release(); tts = null; ttsTier = "" }
        dir(t).deleteRecursively()
    }

    @Synchronized
    private fun open(id: String): OfflineTts {
        val current = tts
        if (current != null && ttsTier == id) return current
        current?.release()
        tts = null
        val t = TIERS[id] ?: throw IllegalArgumentException("unknown size $id")
        if (!isReady(id)) throw IllegalStateException("the ${t.mb} MB voice is not downloaded yet")
        val d = dir(t).absolutePath
        val config = OfflineTtsConfig(
            model = OfflineTtsModelConfig(
                kokoro = OfflineTtsKokoroModelConfig(
                    model = "$d/${t.model}",
                    voices = "$d/voices.bin",
                    tokens = "$d/tokens.txt",
                    dataDir = "$d/espeak-ng-data",
                    lexicon = "$d/lexicon-us-en.txt",
                    lang = "en-us",
                ),
                numThreads = threads,
                debug = false,
                provider = "cpu",
            ),
            maxNumSentences = 1,
            silenceScale = 0.2f,
        )
        val made = OfflineTts(null, config)
        tts = made
        ttsTier = id
        return made
    }

    /** Speak `text` with speaker `sid`, write a WAV file, return its length in seconds. */
    @Synchronized
    fun speak(id: String, text: String, sid: Int, speed: Float, out: File): Double {
        val engine = open(id)
        val started = System.nanoTime()
        val audio = engine.generate(text = text, sid = sid, speed = speed)
        val samples = audio.samples
        val took = (System.nanoTime() - started) / 1e9
        val seconds = samples.size.toDouble() / audio.sampleRate
        Log.i(TAG, "spoke ${text.length} chars: %.1f s of audio in %.1f s on $threads threads".format(seconds, took))
        // The 8-bit model whistles at 4.8 and 9.6 kHz (measured); two narrow notches remove it.
        if (id == "fast") {
            notch(samples, audio.sampleRate, 9600.0, 6.0)
            notch(samples, audio.sampleRate, 4800.0, 8.0)
        }
        writeWav(out, samples, audio.sampleRate)
        return seconds
    }

    /** In-place biquad notch filter (removes one narrow frequency, leaves the voice). */
    private fun notch(x: FloatArray, rate: Int, f0: Double, q: Double) {
        if (f0 >= rate / 2.0) return
        val w = 2 * Math.PI * f0 / rate
        val alpha = Math.sin(w) / (2 * q)
        val c = Math.cos(w)
        val a0 = 1 + alpha
        val b0 = 1 / a0; val b1 = -2 * c / a0; val b2 = 1 / a0; val a1 = -2 * c / a0; val a2 = (1 - alpha) / a0
        var x1 = 0.0; var x2 = 0.0; var y1 = 0.0; var y2 = 0.0
        for (i in x.indices) {
            val v = x[i].toDouble()
            val o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            x2 = x1; x1 = v; y2 = y1; y1 = o
            x[i] = o.toFloat()
        }
    }

    private fun writeWav(file: File, samples: FloatArray, rate: Int) {
        var peak = 0f
        for (s in samples) peak = max(peak, abs(s))
        val gain = if (peak > 0f) min(2f, 0.9f / peak) else 1f
        val n = samples.size
        val bytes = ByteArray(44 + n * 2)
        fun int32(o: Int, v: Int) { bytes[o] = v.toByte(); bytes[o + 1] = (v shr 8).toByte(); bytes[o + 2] = (v shr 16).toByte(); bytes[o + 3] = (v shr 24).toByte() }
        fun int16(o: Int, v: Int) { bytes[o] = v.toByte(); bytes[o + 1] = (v shr 8).toByte() }
        "RIFF".toByteArray().copyInto(bytes, 0); int32(4, 36 + n * 2); "WAVE".toByteArray().copyInto(bytes, 8)
        "fmt ".toByteArray().copyInto(bytes, 12); int32(16, 16); int16(20, 1); int16(22, 1); int32(24, rate); int32(28, rate * 2); int16(32, 2); int16(34, 16)
        "data".toByteArray().copyInto(bytes, 36); int32(40, n * 2)
        var o = 44
        for (s in samples) {
            val v = (max(-1f, min(1f, s * gain)) * 32767).toInt()
            bytes[o] = v.toByte(); bytes[o + 1] = (v shr 8).toByte(); o += 2
        }
        RandomAccessFile(file, "rw").use { it.setLength(0); it.write(bytes) }
    }
}

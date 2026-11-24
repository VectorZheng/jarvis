package expo.modules.jarviscompanion

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream

internal data class Candidate(val bitmap: Bitmap, val sample: Bitmap, val hash: Long, val metadata: JSONObject, val mono: Long) {
  fun close() { if (!bitmap.isRecycled) bitmap.recycle(); if (!sample.isRecycled) sample.recycle() }
}
internal class FramePipeline {
  private var previous: Long? = null
  private var analyzed: Long? = null
  private var stable = 0
  private var dimensions = ""
  private var excluded: Rect? = null
  private var previousSample: Bitmap? = null
  private var analyzedSample: Bitmap? = null
  private var blankCount = 0
  var latest: Candidate? = null; private set
  private var pendingStable = false
  fun reset() {
    previous = null; analyzed = null; stable = 0; blankCount = 0; excluded = null; dimensions = ""
    previousSample?.recycle(); previousSample = null; analyzedSample?.recycle(); analyzedSample = null
    latest?.close(); latest = null; pendingStable = false
  }
  fun dropPending() {
    previous = null; stable = 0; blankCount = 0; previousSample?.recycle(); previousSample = null
    latest?.close(); latest = null; pendingStable = false
  }
  fun take(): Candidate? = if (!pendingStable) null else latest.also { latest = null; pendingStable = false }
  fun unchanged(mono: Long) {
    if (blankCount > 0) { blankCount++; if (blankCount >= 5) throw Fault("NO_USABLE_PREVIEW") }
    val candidate = latest ?: return
    // 静止显示可能不再排入新buffer；再次采样同一buffer，不刷新原始帧龄或另存旧图。
    if (mono - candidate.mono >= 1000) { stable = 2; pendingStable = true }
  }
  fun markAttempt(candidate: Candidate) {
    val copy = candidate.sample.copy(Bitmap.Config.ARGB_8888, true) ?: throw Fault("NO_USABLE_PREVIEW")
    analyzedSample?.recycle(); analyzedSample = copy
    analyzed = candidate.hash
  }
  fun accept(bitmap: Bitmap, metadata: JSONObject, mono: Long, overlay: Rect?): Boolean {
    val signature = "${bitmap.width}:${bitmap.height}"
    if (signature != dimensions) { reset(); dimensions = signature }
    val paint = Paint().apply { color = Color.BLACK }
    if (overlay != null) {
      Canvas(bitmap).drawRect(overlay, paint)
      val mask = Rect((overlay.left * 64.0 / bitmap.width).toInt() - 1, (overlay.top * 64.0 / bitmap.height).toInt() - 1,
        kotlin.math.ceil(overlay.right * 64.0 / bitmap.width).toInt() + 1, kotlin.math.ceil(overlay.bottom * 64.0 / bitmap.height).toInt() + 1)
      if (!mask.intersect(0, 0, 64, 64)) mask.setEmpty()
      val before = excluded?.toShortString()
      if (excluded == null) excluded = mask else excluded!!.union(mask)
      if (before != excluded?.toShortString()) {
        // 将人物经过的区域从前后两帧一起排除，拖动本身不能触发付费分析。
        previousSample?.let { Canvas(it).drawRect(excluded!!, paint); previous = hash(it) }
        analyzedSample?.let { Canvas(it).drawRect(excluded!!, paint); analyzed = hash(it) }
        latest?.close(); latest = null; pendingStable = false
      }
    }
    val scaled = Bitmap.createScaledBitmap(bitmap, 64, 64, true)
    val tiny = try { scaled.copy(Bitmap.Config.ARGB_8888, true) ?: throw Fault("NO_USABLE_PREVIEW") }
      finally { if (scaled !== bitmap) scaled.recycle() }
    try {
      excluded?.let { Canvas(tiny).drawRect(it, paint) }
      val pixels = IntArray(4096); tiny.getPixels(pixels, 0, 64, 0, 0, 64, 64)
      var min = 255; var max = 0
      pixels.forEachIndexed { i, pixel -> if (excluded?.contains(i % 64, i / 64) != true) { min = minOf(min, gray(pixel)); max = maxOf(max, gray(pixel)) } }
      if (max - min < 5) {
        bitmap.recycle(); previous = null; stable = 0; blankCount++
        previousSample?.recycle(); previousSample = null; latest?.close(); latest = null; pendingStable = false
        if (blankCount >= 5) throw Fault("NO_USABLE_PREVIEW")
        return false
      }
      blankCount = 0
      val hash = hash(tiny)
      stable = if (previous != null && distance(previous!!, hash) < 6) 2 else 1
      previous = hash; previousSample?.recycle(); previousSample = tiny
      if (analyzed != null && distance(analyzed!!, hash) < 6) {
        latest?.close(); latest = null; pendingStable = false; bitmap.recycle(); return false
      }
      val sample = tiny.copy(Bitmap.Config.ARGB_8888, true) ?: throw Fault("NO_USABLE_PREVIEW")
      latest?.close(); latest = Candidate(bitmap, sample, hash, metadata, mono)
      pendingStable = stable >= 2; return pendingStable
    } finally { if (previousSample !== tiny && !tiny.isRecycled) tiny.recycle() }
  }
  companion object {
    fun capturedMono(timestampNs: Long, nowNs: Long, elapsedMs: Long): Long {
      // Surface队列使用MONOTONIC时间戳；未知时基、未来或积压帧一律拒绝，不用回调到达时间刷新帧龄。
      demand(timestampNs > 0 && nowNs >= timestampNs && nowNs - timestampNs <= 20000000000L, "NO_USABLE_PREVIEW")
      val ageMs = (nowNs - timestampNs + 999999L) / 1000000L
      demand(elapsedMs >= ageMs, "NO_USABLE_PREVIEW")
      return elapsedMs - ageMs
    }
    fun distance(a: Long, b: Long) = java.lang.Long.bitCount(a xor b)
    private fun gray(p: Int) = (Color.red(p) * 299 + Color.green(p) * 587 + Color.blue(p) * 114) / 1000
    fun hash(sample: Bitmap): Long {
      val b = Bitmap.createScaledBitmap(sample, 9, 8, true)
      try {
        var hash = 0L
        for (y in 0..7) for (x in 0..7) if (gray(b.getPixel(x,y)) > gray(b.getPixel(x+1,y))) hash = hash or (1L shl (y*8+x))
        return hash
      } finally { if (b !== sample) b.recycle() }
    }
    fun image(bitmap: Bitmap): JSONObject {
      val scale = minOf(1.0, 1024.0 / maxOf(bitmap.width, bitmap.height))
      val small = Bitmap.createScaledBitmap(bitmap, maxOf(1, (bitmap.width * scale).toInt()), maxOf(1, (bitmap.height * scale).toInt()), true)
      try {
        for (quality in listOf(82, 70, 58, 44, 30, 18)) {
          val output = ByteArrayOutputStream(); demand(small.compress(Bitmap.CompressFormat.JPEG, quality, output), "NO_USABLE_PREVIEW")
          val bytes = output.toByteArray()
          if (bytes.size <= 204800) return obj("mimeType" to "image/jpeg", "width" to small.width, "height" to small.height, "base64" to Base64.encodeToString(bytes, Base64.NO_WRAP))
        }
        throw Fault("PAYLOAD_TOO_LARGE")
      } finally { if (small !== bitmap) small.recycle() }
    }
  }
}

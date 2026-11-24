package expo.modules.jarviscompanion

import android.content.Context
import android.os.SystemClock
import android.provider.Settings
import org.json.JSONObject
import kotlin.math.abs

internal interface TimeSource { fun wall(): Long; fun mono(): Long; fun boot(): String }
internal class DeviceTime(private val context: Context) : TimeSource {
  override fun wall() = System.currentTimeMillis().coerceAtLeast(0)
  override fun mono() = SystemClock.elapsedRealtime()
  override fun boot(): String = "boot-" + Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1)
}
internal object TimerClock {
  fun anchor(time: TimeSource) = obj("bootId" to time.boot(), "anchorMonotonicMs" to time.mono(), "anchorWallTimeMs" to time.wall(), "elapsedActiveMs" to 0L, "accumulatedPausedMs" to 0L)
  fun trustworthy(clock: JSONObject, time: TimeSource): Boolean {
    val delta = time.mono() - clock.getLong("anchorMonotonicMs")
    return clock.getString("bootId") != "boot--1" && clock.getString("bootId") == time.boot() && delta >= 0 && abs((time.wall() - clock.getLong("anchorWallTimeMs")) - delta) <= 120000
  }
  fun elapsed(record: JSONObject, time: TimeSource): Long {
    val c = record.o("clock")
    return c.getLong("elapsedActiveMs") + if (record.getString("timerState") == "running") (time.mono() - c.getLong("anchorMonotonicMs")).coerceAtLeast(0) else 0
  }
  fun reanchor(record: JSONObject, time: TimeSource) {
    val c = record.o("clock")
    if (record.s("timerState") == "running") c.put("elapsedActiveMs", elapsed(record, time).coerceAtMost(record.getLong("durationMs")))
    else if (record.s("timerState") == "paused") c.put("accumulatedPausedMs", c.getLong("accumulatedPausedMs") + (time.mono() - c.getLong("anchorMonotonicMs")).coerceAtLeast(0))
    c.put("anchorMonotonicMs", time.mono()).put("anchorWallTimeMs", time.wall())
  }
  fun reconcile(record: JSONObject, time: TimeSource): Boolean {
    if (record.s("timerState") !in setOf("running", "paused")) return false
    if (!trustworthy(record.o("clock"), time)) {
      record.put("timerState", "interrupted").put("clockIntegrity", "needs_review")
      return true
    }
    if (record.s("timerState") == "running" && elapsed(record, time) >= record.getLong("durationMs")) {
      reanchor(record, time)
      record.put("timerState", "finished").put("finishedAt", time.wall()).put("finishReason", "completed")
      return true
    }
    return false
  }
}

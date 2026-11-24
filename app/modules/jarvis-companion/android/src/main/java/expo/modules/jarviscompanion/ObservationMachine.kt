package expo.modules.jarviscompanion

import org.json.JSONObject
import java.net.URI
import kotlin.math.abs

internal object ObservationValidation {
  val reasons = setOf("user", "paused", "stop_all", "locked", "projection_revoked", "permission_revoked", "notification_hidden", "credentials_changed", "credentials_cleared", "service_recreated", "session_limit", "daily_limit", "consecutive_failures", "no_usable_preview", "life_cleared", "clock_uncertain")
  fun origin(value: String) {
    val u = try { URI(value) } catch (_: Exception) { throw Fault("INSECURE_TRANSPORT") }
    demand(u.scheme == "https" && u.host != null && u.rawUserInfo == null && u.rawQuery == null && u.rawFragment == null && (u.rawPath == "" || u.rawPath == null) && (u.port == -1 || u.port == 443), "INSECURE_TRANSPORT")
    val host = u.host.lowercase(); demand(host.contains('.') && !host.endsWith(".local") && host != "localhost" && !host.matches(Regex("[0-9.]+")) && !host.contains(':'), "INSECURE_TRANSPORT")
  }
  fun validate(c: JSONObject, key: JSONObject) {
    c.shape("schemaVersion", "backendOrigin", "provider", "credentialBinding", "taskMode", "cloudConsent", "autoConfirmExpenses", "autoConfirmExpensesAcceptedAt", "budget", "budgetAcceptedAt", "foodContextId")
    demand(c.int("schemaVersion") == 1L); origin(c.s("backendOrigin", 2048)); demand(c.s("taskMode") in setOf("food", "expense", "mixed"))
    val p = c.o("provider"); p.shape("purpose", "preset", "baseUrl", "model", "thinking", "credentialSource")
    demand(p.s("purpose") == "vision" && p.s("thinking") == "disabled")
    val deep = p.s("preset") == "deepseek"
    if (deep) demand(p.s("baseUrl") == "https://api.deepseek.com" && p.s("model") == "deepseek-flash" && p.s("credentialSource") == "chat", "PROVIDER_NOT_ALLOWED")
    else demand(p.s("preset") == "qwen" && p.s("model") == "qwen3-vl-plus" && p.s("credentialSource") == "vision" && p.s("baseUrl") in setOf("https://dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "https://dashscope-us.aliyuncs.com/compatible-mode/v1"), "PROVIDER_NOT_ALLOWED")
    c.o("credentialBinding").apply { shape("credentialId", "credentialRevision"); id("credentialId"); int("credentialRevision", 1) }
    key.shape("credentialId", "credentialRevision", "apiKey"); key.id("credentialId"); key.int("credentialRevision", 1)
    val apiKey = key.s("apiKey", 4096); demand(apiKey.none { it == '\r' || it == '\n' || it == '\u0000' }, "AUTH_REQUIRED")
    demand(key.s("credentialId", 128) == c.o("credentialBinding").s("credentialId", 128) && key.int("credentialRevision") == c.o("credentialBinding").int("credentialRevision"), "AUTH_REQUIRED")
    c.o("cloudConsent").apply {
      shape("accepted", "acceptedAt", "provider", "backendOrigin", "reuseChatKeyAccepted")
      demand(bool("accepted") && bool("reuseChatKeyAccepted") == deep && s("backendOrigin", 2048) == c.s("backendOrigin", 2048) && canonical(o("provider")) == canonical(p), "CONSENT_REQUIRED"); int("acceptedAt")
    }
    if (c.bool("autoConfirmExpenses")) c.int("autoConfirmExpensesAcceptedAt") else demand(c.isNull("autoConfirmExpensesAcceptedAt"))
    val b = c.o("budget"); b.shape("sessionDurationMs", "maxSessionAttempts", "maxDailyAttempts")
    b.int("sessionDurationMs", 1, 3600000); b.int("maxSessionAttempts", 1, 120); b.int("maxDailyAttempts", 1, 500)
    val defaults = b.int("sessionDurationMs") == 1800000L && b.int("maxSessionAttempts") == 40L && b.int("maxDailyAttempts") == 100L
    if (!defaults) c.int("budgetAcceptedAt") else if (!c.isNull("budgetAcceptedAt")) c.int("budgetAcceptedAt")
    if (!c.isNull("foodContextId")) c.id("foodContextId")
  }
}

internal class ObservationMachine(private val repo: LifeRepository) {
  val time = repo.time
  var session: JSONObject? = null; private set
  var config: JSONObject? = null; private set
  var credentials: JSONObject? = null; private set
  var state = "stopped"; private set
  var generation = repo.meta("generation", "1").toLong(); private set
  var reason: String? = null; private set
  var sessionAttempts = repo.meta("sessionAttempts").toInt(); private set
  var failures = 0; private set
  var lastObservationAt: Long? = null
  var lastRecordId: String? = null
  var lastAttemptMono = Long.MIN_VALUE; private set
  private var startMono = 0L
  private var startWall = 0L
  private var startBoot = ""
  private var sessionLimit = 40
  private var dailyLimit = 100
  private var duration = 1800000L
  init {
    if (repo.meta("observationActive") == "1") {
      demand(generation < 9007199254740991, "STORAGE_FAILED"); generation++
      repo.transaction { repo.putMeta("generation", generation); repo.putMeta("observationActive", 0) }
      reason = "service_recreated"
    }
  }
  fun start(c: JSONObject, key: JSONObject): JSONObject {
    demand(state == "stopped", "ALREADY_RUNNING"); ObservationValidation.validate(c, key)
    checkDailyClock()
    sessionLimit = c.o("budget").getInt("maxSessionAttempts"); dailyLimit = c.o("budget").getInt("maxDailyAttempts"); duration = c.o("budget").getLong("sessionDurationMs")
    demand(repo.meta("dailyAttempts").toInt() < dailyLimit, "LIMIT_REACHED")
    demand(generation < 9007199254740990, "STORAGE_FAILED")
    val next = generation + 1
    repo.transaction { repo.putMeta("generation", next); repo.putMeta("observationActive", 1); repo.putMeta("sessionAttempts", 0) }
    config = c.copy(); credentials = key.copy()
    generation = next; startMono = time.mono(); startWall = time.wall(); startBoot = time.boot()
    sessionAttempts = 0; failures = 0; lastAttemptMono = Long.MIN_VALUE; reason = null; state = "starting"
    lastObservationAt = null; lastRecordId = null
    return obj("sessionId" to uid("session_"), "generation" to generation, "startedAt" to startWall).also { session = it }
  }
  fun ready() { demand(state == "starting", "STALE_GENERATION"); state = "observing" }
  fun stop(why: String): JSONObject {
    demand(why in ObservationValidation.reasons)
    val old = session; val invalidated = if (state == "stopped") null else generation
    if (invalidated != null) generation++
    state = "stopped"; session = null; config = null; credentials = null; reason = why
    if (invalidated != null) repo.transaction { repo.putMeta("generation", generation); repo.putMeta("observationActive", 0) }
    return obj("stoppedSessionId" to old?.get("sessionId"), "invalidatedGeneration" to invalidated, "currentGeneration" to generation, "reason" to why)
  }
  fun guard(metadata: JSONObject, capturedMono: Long) {
    demand(state == "observing", "STALE_GENERATION")
    VisionRules.frameGuard(metadata, session?.getString("sessionId"), generation, time.mono() - capturedMono)
    val limit = limitReason(includeAttempts = false)
    demand(limit == null, if (limit == "clock_uncertain") "CLOCK_UNCERTAIN" else "LIMIT_REACHED")
  }
  fun limitReason(includeAttempts: Boolean = true): String? {
    if (state == "stopped") return null
    if (time.boot() != startBoot || time.mono() < startMono || abs((time.wall() - startWall) - (time.mono() - startMono)) > 120000) return "clock_uncertain"
    if (time.mono() - startMono >= duration || (includeAttempts && sessionAttempts >= sessionLimit)) return "session_limit"
    if (includeAttempts && repo.meta("dailyAttempts").toInt() >= dailyLimit) return "daily_limit"
    return null
  }
  fun canAttempt() = lastAttemptMono == Long.MIN_VALUE || time.mono() - lastAttemptMono >= 8000
  fun reserveAttempt(metadata: JSONObject, capturedMono: Long) {
    guard(metadata, capturedMono); demand(state == "observing", "STALE_GENERATION"); demand(canAttempt(), "LIMIT_REACHED")
    checkDailyClock(); demand(limitReason() == null, "LIMIT_REACHED")
    repo.transaction {
      repo.putMeta("dailyAttempts", repo.meta("dailyAttempts").toInt() + 1)
      repo.putMeta("dailyWall", time.wall()); repo.putMeta("dailyMono", time.mono()); repo.putMeta("dailyBoot", time.boot())
      repo.putMeta("sessionAttempts", sessionAttempts + 1)
    }
    sessionAttempts++; lastAttemptMono = time.mono()
  }
  fun succeeded() { failures = 0 }
  fun failed(): Boolean { failures++; return failures >= 3 }
  private fun checkDailyClock() {
    val wall = time.wall(); val mono = time.mono(); val boot = time.boot()
    demand(boot != "boot--1", "CLOCK_UNCERTAIN")
    val previous = repo.meta("dailyWall").toLong(); val sameBoot = repo.meta("dailyBoot", "") == boot
    val bucket = utcDay(wall)
    val oldBucket = repo.meta("dailyBucket", "")
    val delta = mono - repo.meta("dailyMono").toLong()
    val anomaly = previous != 0L && (wall < previous || (sameBoot && (delta < 0 || abs((wall - previous) - delta) > 120000)) || (!sameBoot && bucket != oldBucket))
    repo.transaction {
      // 跨开机/异常时先重锚且保留已用次数；连续可信24小时后才允许恢复日额度。
      if (previous != 0L && (!sameBoot || anomaly)) {
        repo.putMeta("dailyHeld", 1); repo.putMeta("dailyHoldMono", mono)
      }
      val held = repo.meta("dailyHeld") == "1"
      val holdExpired = held && sameBoot && !anomaly && oldBucket != bucket && mono - repo.meta("dailyHoldMono").toLong() >= 86400000L
      if (previous == 0L || holdExpired || (!held && oldBucket != bucket)) {
        repo.putMeta("dailyAttempts", 0); repo.putMeta("dailyHeld", 0)
      }
      repo.putMeta("dailyBucket", bucket)
      repo.putMeta("dailyWall", wall); repo.putMeta("dailyMono", mono); repo.putMeta("dailyBoot", boot)
    }
    demand(!anomaly, "CLOCK_UNCERTAIN")
  }
  fun snapshot() = obj("state" to state, "session" to session, "generation" to generation, "stopReason" to reason,
    "counters" to obj("sessionAttempts" to sessionAttempts, "dailyAttempts" to repo.meta("dailyAttempts").toInt(), "consecutiveFailures" to failures,
      "sessionLimit" to sessionLimit, "dailyLimit" to dailyLimit, "sessionEndsAt" to if (session == null) null else startWall + duration,
      "dailyBucket" to repo.meta("dailyBucket", utcDay(time.wall()))),
    "lastObservationAt" to lastObservationAt, "lastRecordId" to lastRecordId)
}

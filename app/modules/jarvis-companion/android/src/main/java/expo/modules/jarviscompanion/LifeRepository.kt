package expo.modules.jarviscompanion

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject
import java.text.Normalizer
import java.util.Locale

/** 所有入口由 NativeRuntime 的同一个串行执行器调用，提交与停止没有并行窗口。 */
internal class LifeRepository(context: Context, val time: TimeSource, name: String? = "jarvis-life.db") : SQLiteOpenHelper(context, name, null, 1) {
  override fun onConfigure(db: SQLiteDatabase) { db.execSQL("PRAGMA secure_delete=ON"); db.setForeignKeyConstraintsEnabled(true) }
  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL("CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT NOT NULL)")
    db.execSQL("CREATE TABLE records(id TEXT PRIMARY KEY,body TEXT NOT NULL)")
    db.execSQL("CREATE TABLE receipts(op TEXT PRIMARY KEY,hash TEXT NOT NULL,body TEXT NOT NULL)")
    db.execSQL("CREATE TABLE outbox(revision INTEGER PRIMARY KEY,body TEXT NOT NULL)")
    db.execSQL("CREATE TABLE observations(id TEXT PRIMARY KEY,recordId TEXT NOT NULL)")
    db.execSQL("CREATE TABLE identities(hash TEXT PRIMARY KEY,recordId TEXT NOT NULL)")
    db.execSQL("CREATE TABLE transactions(hash TEXT PRIMARY KEY,recordId TEXT NOT NULL)")
    mapOf("revision" to "0", "ack" to "0", "floor" to "0", "generation" to "1").forEach { (k,v) -> db.execSQL("INSERT INTO meta VALUES (?,?)", arrayOf(k,v)) }
  }
  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) { throw Fault("STORAGE_FAILED") }
  fun meta(k: String, fallback: String = "0"): String = readableDatabase.rawQuery("SELECT v FROM meta WHERE k=?", arrayOf(k)).use { if (it.moveToFirst()) it.getString(0) else fallback }
  fun putMeta(k: String, v: Any) { writableDatabase.execSQL("INSERT OR REPLACE INTO meta VALUES (?,?)", arrayOf(k,v.toString())) }
  fun revision() = meta("revision").toLong()
  fun <T> transaction(block: () -> T): T {
    val db = writableDatabase; db.beginTransaction()
    try { val value = block(); db.setTransactionSuccessful(); return value } finally { db.endTransaction() }
  }
  private fun lookup(table: String, column: String, id: String): String? = readableDatabase.rawQuery("SELECT $column FROM $table WHERE ${if (table == "records") "id" else if (table == "receipts") "op" else if (table == "observations") "id" else "hash"}=?", arrayOf(id)).use { if (it.moveToFirst()) it.getString(0) else null }
  fun record(id: String): JSONObject = lookup("records", "body", id)?.let(::JSONObject) ?: throw Fault("NOT_FOUND")
  fun records(): List<JSONObject> = readableDatabase.rawQuery("SELECT body FROM records ORDER BY id", null).use { c -> buildList { while (c.moveToNext()) add(JSONObject(c.getString(0))) } }
  fun snapshot(companion: JSONObject, observation: JSONObject) = transaction { obj("schemaVersion" to 1, "authority" to "native_sqlite", "revision" to revision(), "records" to JSONArray(records()), "companion" to companion, "observation" to observation) }
  fun readChanges(after: Long): JSONObject = transaction {
    demand(after in 0..revision(), "INVALID_REVISION"); demand(after >= meta("floor").toLong(), "SNAPSHOT_REQUIRED")
    val changes = readableDatabase.rawQuery("SELECT body FROM outbox WHERE revision>? ORDER BY revision LIMIT 100", arrayOf(after.toString())).use { c -> JSONArray().apply { while (c.moveToNext()) put(JSONObject(c.getString(0))) } }
    val through = if (changes.length() == 0) after else changes.getJSONObject(changes.length() - 1).getLong("revision")
    obj("schemaVersion" to 1, "afterRevision" to after, "throughRevision" to through, "currentRevision" to revision(), "changes" to changes, "hasMore" to (through < revision()))
  }
  fun ack(value: Long): JSONObject = transaction {
    demand(value in 0..revision(), "INVALID_REVISION")
    val ack = maxOf(meta("ack").toLong(), value); putMeta("ack", ack)
    writableDatabase.delete("outbox", "revision<=?", arrayOf(ack.toString())); putMeta("floor", maxOf(meta("floor").toLong(), ack))
    obj("schemaVersion" to 1, "ackedRevision" to ack)
  }
  private fun base(kind: String, text: String, source: JSONObject, status: String) = obj(
    "schemaVersion" to 1, "id" to uid("record_"), "revision" to 0, "kind" to kind, "text" to text,
    "source" to source, "status" to status, "createdAt" to time.wall(), "updatedAt" to time.wall(), "lastSeenAt" to null, "observationIds" to JSONArray())
  private fun emit(op: String, hash: String, change: JSONObject): JSONObject {
    val revision = revision() + 1; demand(revision <= 9007199254740991, "STORAGE_FAILED")
    val eventId = uid("event_"); val now = time.wall(); val ids = JSONArray()
    if (change.s("kind") == "upsert") {
      val r = change.o("record"); r.put("revision", revision).put("updatedAt", now)
      ids.put(r.id("id")); writableDatabase.execSQL("INSERT OR REPLACE INTO records VALUES (?,?)", arrayOf(r.id("id"), r.toString()))
    } else if (change.s("kind") == "delete") ids.put(change.id("recordId"))
    val event = obj("schemaVersion" to 1, "eventId" to eventId, "opId" to op, "revision" to revision, "occurredAt" to now, "change" to change)
    val receipt = obj("schemaVersion" to 1, "opId" to op, "eventId" to eventId, "revision" to revision, "recordIds" to ids, "committedAt" to now, "replayed" to false)
    writableDatabase.execSQL("INSERT INTO receipts VALUES (?,?,?)", arrayOf(op, hash, receipt.toString()))
    writableDatabase.execSQL("INSERT INTO outbox VALUES (?,?)", arrayOf(revision, event.toString())); putMeta("revision", revision)
    return receipt
  }
  fun replay(command: JSONObject): JSONObject? {
    val op = command.id("opId"); val hash = commandHash(command)
    val previous = lookup("receipts", "body", op) ?: return null
    demand(lookup("receipts", "hash", op) == hash, "OP_ID_CONFLICT")
    return JSONObject(previous).put("replayed", true)
  }
  private fun commandHash(c: JSONObject) = digest(canonical(obj("kind" to c.get("kind"), "payload" to c.get("payload"), "observationIds" to c.get("observationIds"))))
  fun validateEnvelope(c: JSONObject) {
    c.shape("schemaVersion", "opId", "kind", "payload", "observationIds"); demand(c.int("schemaVersion") == 1L)
    demand(!c.id("opId").startsWith("internal."), "INVALID_REQUEST"); c.o("payload")
    val ids = c.a("observationIds"); demand(ids.length() <= 64)
    val values = (0 until ids.length()).map { obj("id" to ids.get(it)).id("id") }; demand(values.toSet().size == values.size)
    demand(c.s("kind") in setOf("note.create", "expense.create", "location.create", "record.confirm", "record.revoke", "record.delete", "life.clear", "pomodoro.start", "pomodoro.pause", "pomodoro.resume", "pomodoro.finish"))
  }
  private fun manual(p: JSONObject, voiceOnly: Boolean = false): JSONObject {
    val source = p.s("source"); demand(source in if (voiceOnly) setOf("manual_text", "manual_voice") else setOf("manual_text", "manual_voice", "manual_action"))
    return obj("kind" to source)
  }
  private fun expense(p: JSONObject) {
    p.s("text", 2000); p.s("purpose"); p.nullableText("merchant"); demand(p.s("currency") == "CNY", "UNSUPPORTED_CURRENCY"); p.int("amountMinor", 1, 999999999, "INVALID_AMOUNT")
  }
  private fun target(p: JSONObject, c: JSONObject): JSONObject {
    val r = record(p.id("recordId")); demand(p.int("expectedRevision") == r.getLong("revision"), "CONFLICT")
    val known = (0 until r.a("observationIds").length()).map { r.a("observationIds").getString(it) }.toSet()
    demand((0 until c.a("observationIds").length()).all { c.a("observationIds").getString(it) in known })
    return r
  }
  private fun privacyBoundary() {
    writableDatabase.delete("outbox", null, null); putMeta("floor", revision() + 1)
  }
  fun submit(c: JSONObject): JSONObject = transaction {
    validateEnvelope(c); replay(c)?.let { return@transaction it }
    val kind = c.s("kind"); val p = c.o("payload"); val op = c.id("opId")
    if (kind.endsWith(".create") || kind in setOf("life.clear", "pomodoro.start")) demand(c.a("observationIds").length() == 0)
    var r: JSONObject? = null; var change: JSONObject? = null
    when (kind) {
      "note.create" -> { p.shape("text", "source"); r = base("note", p.s("text", 2000), manual(p), "confirmed") }
      "expense.create" -> {
        p.shape("text", "amountMinor", "currency", "purpose", "merchant", "source"); expense(p)
        r = base("expense", p.s("text", 2000), manual(p, true), "confirmed")
        listOf("amountMinor", "currency", "purpose", "merchant").forEach { r!!.put(it, p.get(it)) }
        r!!.put("paymentStatus", "paid").put("transaction", JSONObject.NULL).put("evidence", JSONArray())
      }
      "location.create" -> {
        p.shape("text", "latitude", "longitude", "accuracyMeters", "capturedAt", "userConfirmed"); demand(p.bool("userConfirmed")); p.int("capturedAt")
        p.num("latitude", -90.0, 90.0); p.num("longitude", -180.0, 180.0); if (!p.isNull("accuracyMeters")) p.num("accuracyMeters", 0.0, 9007199254740991.0)
        r = base("location", p.s("text", 2000), obj("kind" to "foreground_location"), "confirmed")
        listOf("latitude", "longitude", "accuracyMeters").forEach { r!!.put(it, p.get(it)) }
      }
      "life.clear" -> {
        p.shape("scope", "expectedRevision", "userConfirmed"); demand(p.s("scope") == "all" && p.bool("userConfirmed")); demand(p.int("expectedRevision") == revision(), "CONFLICT")
        records().forEach { retireTransaction(it) }
        writableDatabase.delete("records", null, null); privacyBoundary(); change = obj("kind" to "clear")
      }
      "pomodoro.start" -> {
        p.shape("text", "phase", "durationMs", "source"); demand(p.s("phase") in setOf("focus", "break")); p.int("durationMs", 1000, 10800000)
        demand(records().none { it.s("kind") == "pomodoro" && it.s("status") != "revoked" && it.s("timerState") in setOf("running", "paused") }, "ALREADY_RUNNING")
        r = base("pomodoro", p.s("text", 2000), manual(p), "confirmed")
        r!!.put("phase", p.get("phase")).put("durationMs", p.get("durationMs")).put("timerState", "running").put("startedAt", time.wall()).put("pausedAt", JSONObject.NULL).put("finishedAt", JSONObject.NULL).put("finishReason", JSONObject.NULL).put("clock", TimerClock.anchor(time)).put("clockIntegrity", "verified")
      }
      else -> {
        r = target(p, c)
        when (kind) {
          "record.confirm" -> {
            p.shape("recordId", "expectedRevision", "userConfirmed", "facts"); demand(p.bool("userConfirmed")); demand(r!!.s("status") in setOf("observed", "pending_confirmation"), "CONFLICT")
            val facts = p.o("facts"); demand(facts.s("kind") == r!!.s("kind"))
            if (r!!.s("kind") == "foodObservation") {
              facts.shape("kind", "name", "brand", "barcode", "quantity", "expiresOn"); VisionRules.foodFacts(facts)
              val identity = foodIdentity(facts, r!!.opt("foodContextId"))
              val existing = lookup("identities", "recordId", identity)
              demand(existing == null || existing == r!!.id("id"), "CONFLICT")
              writableDatabase.execSQL("INSERT OR IGNORE INTO identities VALUES (?,?)", arrayOf(identity, r!!.id("id")))
            } else {
              demand(r!!.s("kind") == "expense"); demand(r!!.isNull("currency") || r!!.s("currency") == "CNY", "UNSUPPORTED_CURRENCY")
              facts.shape("kind", "text", "amountMinor", "currency", "purpose", "merchant"); expense(facts)
              claimTransaction(r!!)
            }
            facts.keysSet().filter { it != "kind" }.forEach { r!!.put(it, facts.get(it)) }; r!!.put("status", "confirmed")
          }
          "record.revoke", "record.delete" -> {
            p.shape("recordId", "expectedRevision", "userConfirmed"); demand(p.bool("userConfirmed"))
            retireTransaction(r!!)
            if (kind == "record.delete") {
              writableDatabase.delete("records", "id=?", arrayOf(r!!.id("id"))); privacyBoundary(); change = obj("kind" to "delete", "recordId" to r!!.id("id")); r = null
            } else {
              r!!.put("status", "revoked")
              if (r!!.s("kind") == "pomodoro") {
                if (TimerClock.trustworthy(r!!.o("clock"), time)) TimerClock.reanchor(r!!, time) else r!!.put("clockIntegrity", "needs_review")
                r!!.put("timerState", "finished").put("finishedAt", time.wall()).put("finishReason", "user")
              }
            }
          }
          else -> {
            p.shape("recordId", "expectedRevision"); demand(r!!.s("kind") == "pomodoro" && r!!.s("status") != "revoked", "CONFLICT")
            val state = r!!.s("timerState")
            if (kind != "pomodoro.finish") demand(r!!.s("clockIntegrity") == "verified" && TimerClock.trustworthy(r!!.o("clock"), time), "CLOCK_UNCERTAIN")
            when (kind) {
              "pomodoro.pause" -> {
                demand(state == "running", "CONFLICT")
                if (!TimerClock.reconcile(r!!, time)) { TimerClock.reanchor(r!!, time); r!!.put("timerState", "paused").put("pausedAt", time.wall()) }
              }
              "pomodoro.resume" -> { demand(state == "paused", "CONFLICT"); TimerClock.reanchor(r!!, time); r!!.put("timerState", "running").put("pausedAt", JSONObject.NULL) }
              "pomodoro.finish" -> {
                demand(state != "finished", "CONFLICT")
                if (TimerClock.trustworthy(r!!.o("clock"), time)) TimerClock.reanchor(r!!, time) else r!!.put("clockIntegrity", "needs_review")
                r!!.put("timerState", "finished").put("finishedAt", time.wall()).put("finishReason", "user")
              }
            }
          }
        }
      }
    }
    emit(op, commandHash(c), change ?: obj("kind" to "upsert", "record" to r))
  }
  private fun foodIdentity(o: JSONObject, contextId: Any?) = digest(canonical(JSONArray().put(normal(o.s("name"))).put(o.opt("brand")?.takeIf { it != JSONObject.NULL }?.toString()?.let(::normal)).put(o.opt("barcode")).put(contextId)))
  private fun transactionHash(o: JSONObject): String? = if (o.isNull("transaction")) null else digest(canonical(o.o("transaction")))
  private fun retireTransaction(r: JSONObject) {
    if (r.s("kind") != "expense") return
    val hash = transactionHash(r) ?: return
    writableDatabase.execSQL("INSERT OR IGNORE INTO transactions VALUES (?,?)", arrayOf(hash, r.id("id")))
  }
  private fun claimTransaction(r: JSONObject) {
    val hash = transactionHash(r) ?: return
    val existing = lookup("transactions", "recordId", hash); demand(existing == null || existing == r.id("id"), "CONFLICT")
    writableDatabase.execSQL("INSERT OR IGNORE INTO transactions VALUES (?,?)", arrayOf(hash, r.id("id")))
  }
  fun commitVision(observations: List<JSONObject>, metadata: JSONObject, config: JSONObject, guard: () -> Unit): List<JSONObject> = transaction {
    guard()
    metadata.shape("sessionId", "generation", "frameId", "capturedAt", "taskMode"); metadata.int("capturedAt")
    VisionRules.validateResponse(obj("schemaVersion" to 1, "sessionId" to metadata.get("sessionId"), "generation" to metadata.get("generation"),
      "frameId" to metadata.get("frameId"), "observations" to JSONArray(observations), "usage" to obj("inputTokens" to null, "outputTokens" to null, "totalTokens" to null)), metadata)
    val receipts = mutableListOf<JSONObject>()
    observations.forEach { o ->
      val observationId = o.id("observationId")
      if (lookup("observations", "recordId", observationId) != null) return@forEach
      val status = VisionRules.status(o, config.bool("autoConfirmExpenses"), !config.isNull("autoConfirmExpensesAcceptedAt"))
      val food = o.s("kind") == "food"
      val identity = if (food) foodIdentity(o, config.opt("foodContextId")) else null
      val existing = if (food) lookup("identities", "recordId", identity!!) else transactionHash(o)?.let { lookup("transactions", "recordId", it) }
      val previous = existing?.let { lookup("records", "body", it)?.let(::JSONObject) }
      if (existing != null && (previous == null || previous.s("status") == "revoked")) {
        writableDatabase.execSQL("INSERT INTO observations VALUES (?,?)", arrayOf(observationId, existing)); return@forEach
      }
      val r = previous ?: base(if (food) "foodObservation" else "expense", if (food) o.s("name") else "屏幕支出候选", metadata.copy().put("kind", "screen_observation"), status)
      if (previous == null) {
        val fields = if (food) listOf("name", "brand", "barcode", "quantity", "expiresOn", "evidence") else listOf("amountMinor", "currency", "merchant", "paymentStatus", "transaction", "evidence")
        fields.forEach { r.put(it, o.get(it)) }
        if (food) { r.put("foodContextId", config.get("foodContextId")); writableDatabase.execSQL("INSERT INTO identities VALUES (?,?)", arrayOf(identity, r.id("id"))) }
        else r.put("purpose", JSONObject.NULL)
      } else {
        r.put("evidence", o.get("evidence"))
        // 不累加数量，不用新画面复活撤销项，也不降低用户确认状态。
      }
      r.put("lastSeenAt", metadata.get("capturedAt"))
      val ids = r.a("observationIds"); val kept = JSONArray(); for (i in maxOf(0, ids.length() - 63) until ids.length()) kept.put(ids.get(i)); kept.put(observationId); r.put("observationIds", kept)
      if (!food && r.s("status") == "confirmed") claimTransaction(r)
      writableDatabase.execSQL("INSERT INTO observations VALUES (?,?)", arrayOf(observationId, r.id("id")))
      receipts += emit("internal." + observationId, digest(canonical(o)), obj("kind" to "upsert", "record" to r))
    }
    guard(); receipts
  }
  private fun normal(v: String) = Normalizer.normalize(v, Normalizer.Form.NFKC).trim().lowercase(Locale.ROOT).replace(Regex("\\s+"), " ")
  fun reconcileTimers(): List<JSONObject> = transaction {
    records().filter { it.s("kind") == "pomodoro" && it.s("status") != "revoked" }.mapNotNull { r ->
      if (TimerClock.reconcile(r, time)) emit(uid("internal.timer."), digest(r.toString()), obj("kind" to "upsert", "record" to r)) else null
    }
  }
}

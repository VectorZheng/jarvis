package expo.modules.jarviscompanion

import android.util.JsonReader
import android.util.JsonToken
import org.json.JSONArray
import org.json.JSONObject
import java.io.StringReader
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.text.ParsePosition
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

internal class Fault(val code: String) : RuntimeException(code) {
  fun json() = obj("code" to code, "message" to when (code) {
    "CLOCK_UNCERTAIN" -> "设备时间发生异常，请核对时间与计时；观察需手动重开，已用预算保留。"
    "PERMISSION_DENIED" -> "需要允许系统权限并显示通知。"
    "CONSENT_REQUIRED" -> "请先确认云分析用途与费用。"
    "LIMIT_REACHED" -> "本次观察已达预算上限。"
    "NO_USABLE_PREVIEW" -> "当前画面无法共享，观察已停止。"
    "STORAGE_FAILED" -> "保存失败，未确认记录。"
    "CONFLICT", "INVALID_REVISION", "SNAPSHOT_REQUIRED" -> "记录已变化，请刷新后重试。"
    else -> "操作未完成，请检查状态后重试。"
  }, "retryable" to (code in setOf("NETWORK_UNAVAILABLE", "TIMEOUT", "STORAGE_FAILED", "UPSTREAM_ERROR")))
}
internal fun demand(ok: Boolean, code: String = "INVALID_SCHEMA") { if (!ok) throw Fault(code) }
internal fun obj(vararg pairs: Pair<String, Any?>) = JSONObject().apply { pairs.forEach { put(it.first, it.second ?: JSONObject.NULL) } }
internal fun JSONObject.copy() = JSONObject(toString())
internal fun JSONObject.keysSet(): Set<String> = keys().asSequence().toSet()
internal fun JSONObject.shape(vararg fields: String) = demand(keysSet() == fields.toSet())
internal fun JSONObject.s(key: String, max: Int = 120): String {
  val value = opt(key); demand(value is String && value.isNotBlank() && value.codePointCount(0, value.length) <= max)
  return value as String
}
internal fun JSONObject.id(key: String): String = s(key, 128).also { demand(it.matches(Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"))) }
internal fun JSONObject.num(key: String, min: Double, max: Double, code: String = "INVALID_SCHEMA"): Double {
  val value = opt(key); demand(value is Number, code)
  return (value as Number).toDouble().also { demand(it.isFinite() && it >= min && it <= max, code) }
}
internal fun JSONObject.int(key: String, min: Long = 0, max: Long = 9007199254740991, code: String = "INVALID_SCHEMA"): Long =
  num(key, min.toDouble(), max.toDouble(), code).also { demand(it % 1.0 == 0.0, code) }.toLong()
internal fun JSONObject.bool(key: String): Boolean { demand(opt(key) is Boolean); return getBoolean(key) }
internal fun JSONObject.nullableText(key: String, max: Int = 120): String? { demand(has(key)); return if (isNull(key)) null else s(key, max) }
internal fun JSONObject.o(key: String): JSONObject = (opt(key) as? JSONObject) ?: throw Fault("INVALID_SCHEMA")
internal fun JSONObject.a(key: String): JSONArray = (opt(key) as? JSONArray) ?: throw Fault("INVALID_SCHEMA")
internal fun JSONArray.objects() = (0 until length()).map { (opt(it) as? JSONObject) ?: throw Fault("INVALID_SCHEMA") }
internal fun utcDay(wall: Long): String = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(wall))
internal fun uid(prefix: String) = prefix + UUID.randomUUID().toString()
internal fun digest(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
internal fun canonical(v: Any?): String = when (v) {
  null, JSONObject.NULL -> "null"
  is JSONObject -> v.keysSet().sorted().joinToString(",", "{", "}") { JSONObject.quote(it) + ":" + canonical(v.get(it)) }
  is JSONArray -> (0 until v.length()).joinToString(",", "[", "]") { canonical(v.get(it)) }
  is String -> JSONObject.quote(v)
  is Number -> java.math.BigDecimal(v.toString()).stripTrailingZeros().toPlainString()
  is Boolean -> v.toString()
  else -> throw Fault("INVALID_SCHEMA")
}
internal fun wire(v: Any?): Any? = when (v) {
  null, JSONObject.NULL -> null
  is JSONObject -> v.keysSet().associateWith { wire(v.get(it)) }
  is JSONArray -> (0 until v.length()).map { wire(v.get(it)) }
  else -> v
}
internal fun success(v: Any?) = wire(obj("schemaVersion" to 1, "ok" to true, "value" to v))
internal fun failure(error: Throwable) = wire(obj("schemaVersion" to 1, "ok" to false, "error" to ((error as? Fault) ?: Fault("STORAGE_FAILED")).json()))

internal object StrictJson {
  fun parse(text: String, limit: Int = 32768): JSONObject {
    demand(text.toByteArray(Charsets.UTF_8).size <= limit, "PAYLOAD_TOO_LARGE")
    try {
      JsonReader(StringReader(text)).use { reader ->
        reader.isLenient = false
        val result = read(reader, 0) as? JSONObject ?: throw Fault("INVALID_SCHEMA")
        demand(reader.peek() == JsonToken.END_DOCUMENT)
        return result
      }
    } catch (e: Fault) { throw e } catch (_: Exception) { throw Fault("INVALID_SCHEMA") }
  }
  private fun read(r: JsonReader, depth: Int): Any {
    demand(depth <= 20)
    return when (r.peek()) {
      JsonToken.BEGIN_OBJECT -> JSONObject().apply {
        r.beginObject(); while (r.hasNext()) { val key = r.nextName(); demand(!has(key)); put(key, read(r, depth + 1)) }; r.endObject()
      }
      JsonToken.BEGIN_ARRAY -> JSONArray().apply { r.beginArray(); while (r.hasNext()) { demand(length() < 1000); put(read(r, depth + 1)) }; r.endArray() }
      JsonToken.STRING -> r.nextString()
      JsonToken.BOOLEAN -> r.nextBoolean()
      JsonToken.NULL -> { r.nextNull(); JSONObject.NULL }
      JsonToken.NUMBER -> r.nextString().let { text ->
        demand(text.matches(Regex("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")))
        val exact = java.math.BigDecimal(text)
        val n = text.toDouble()
        demand(n.isFinite() && exact.abs() <= java.math.BigDecimal("9007199254740991"))
        demand(!(n % 1.0 == 0.0 && exact.stripTrailingZeros().scale() > 0))
        n
      }
      else -> throw Fault("INVALID_SCHEMA")
    }
  }
}

internal object VisionRules {
  private val foodFields = arrayOf("kind", "status", "confidence", "evidence", "name", "brand", "barcode", "quantity", "expiresOn")
  private val expenseFields = arrayOf("kind", "status", "confidence", "evidence", "amountMinor", "currency", "merchant", "paymentStatus", "transaction")
  private val evidenceFields = setOf("name", "brand", "barcode", "quantity", "expiresOn", "amountMinor", "currency", "merchant", "paymentStatus", "transactionId", "paymentProvider")
  fun foodFacts(o: JSONObject) {
    o.s("name"); o.nullableText("brand"); o.nullableText("barcode")
    demand(o.has("quantity")); if (!o.isNull("quantity")) o.o("quantity").apply {
      shape("value", "unit"); demand(num("value", 0.0, 1000000.0) > 0); demand(s("unit") in setOf("piece", "pack", "g", "kg", "ml", "l"))
    }
    o.nullableText("expiresOn", 10)?.let {
      demand(it.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")))
      val format = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).apply { isLenient = false; timeZone = TimeZone.getTimeZone("UTC") }
      val position = ParsePosition(0); val date = format.parse(it, position)
      demand(date != null && position.index == it.length && format.format(date) == it)
    }
  }
  fun validateModel(root: JSONObject, mode: String): List<JSONObject> {
    root.shape("schemaVersion", "observations"); demand(root.int("schemaVersion") == 1L)
    val list = root.a("observations").objects(); demand(list.size <= 6)
    list.forEach { o ->
      val kind = o.s("kind"); demand(kind in setOf("food", "expense") && (mode == "mixed" || mode == kind))
      o.shape(*(if (kind == "food") foodFields else expenseFields)); o.num("confidence", 0.0, 1.0)
      val ev = o.a("evidence").objects(); demand(ev.size in 1..8)
      ev.forEach { e ->
        e.shape("field", "kind", "text"); demand(e.s("field") in evidenceFields)
        when (e.s("kind")) { "visual" -> demand(e.isNull("text")); "visible_text" -> e.s("text", 160); else -> throw Fault("INVALID_SCHEMA") }
      }
      if (kind == "food") {
        demand(o.s("status") in setOf("observed", "pending_confirmation")); foodFacts(o)
        demand(ev.any { it.s("field") == "name" })
        listOf("brand", "barcode", "quantity", "expiresOn").forEach { field ->
          if (!o.isNull(field)) demand(ev.any { it.s("field") == field && (field != "expiresOn" || it.s("kind") == "visible_text") })
        }
        if (!o.isNull("expiresOn")) demand(ev.any { it.s("field") == "expiresOn" && it.s("kind") == "visible_text" && it.s("text", 160).contains(o.s("expiresOn")) })
      } else {
        demand(o.s("status") == "pending_confirmation")
        o.nullableText("currency", 3)?.let { demand(it.matches(Regex("[A-Z]{3}"))) }; o.nullableText("merchant")
        demand(o.s("paymentStatus") in setOf("paid", "pending", "price_only", "unknown"))
        if (!o.isNull("amountMinor")) { o.int("amountMinor", 1, 999999999, "INVALID_AMOUNT"); demand(o.optString("currency") == "CNY", "UNSUPPORTED_CURRENCY") }
        if (!o.isNull("transaction")) o.o("transaction").apply { shape("id", "paymentProvider"); s("id", 128); s("paymentProvider") }
      }
    }
    return list
  }
  fun validateResponse(root: JSONObject, metadata: JSONObject): List<JSONObject> {
    root.shape("schemaVersion", "sessionId", "generation", "frameId", "observations", "usage")
    demand(root.int("schemaVersion") == 1L)
    demand(root.id("sessionId") == metadata.id("sessionId") && root.int("generation", 1) == metadata.int("generation", 1) && root.id("frameId") == metadata.id("frameId"), "STALE_GENERATION")
    root.o("usage").apply {
      shape("inputTokens", "outputTokens", "totalTokens"); keysSet().forEach { if (!isNull(it)) int(it) }
      if (!isNull("outputTokens")) int("outputTokens", 0, 768)
    }
    val observations = root.a("observations").objects()
    val stripped = JSONArray()
    observations.forEachIndexed { i, o ->
      val expected = "obs_" + digest(JSONArray().put(metadata.s("sessionId", 128)).put(metadata.int("generation", 1)).put(metadata.s("frameId", 128)).put(i).toString())
      demand(o.id("observationId") == expected)
      stripped.put(o.copy().apply { remove("observationId") })
    }
    validateModel(obj("schemaVersion" to 1, "observations" to stripped), metadata.s("taskMode"))
    return observations
  }
  fun status(o: JSONObject, auto: Boolean, consent: Boolean): String {
    if (o.s("kind") == "food") {
      val evidence = o.a("evidence").objects()
      val reliable = listOf("name", "brand", "barcode").all { field ->
        o.isNull(field) || evidence.any { it.s("field") == field &&
          ((field == "name" && it.s("kind") == "visual") || (it.s("kind") == "visible_text" && it.s("text", 160).contains(o.s(field)))) }
      }
      return if (reliable && o.getDouble("confidence") >= .8 && o.s("status") == "observed") "observed" else "pending_confirmation"
    }
    if (!auto || !consent || o.getDouble("confidence") < .8 || o.s("paymentStatus") != "paid" || o.optString("currency") != "CNY" || o.isNull("amountMinor") || o.isNull("merchant") || o.isNull("transaction")) return "pending_confirmation"
    val ev = o.a("evidence").objects().filter { it.s("kind") == "visible_text" }.groupBy { it.s("field") }
    fun match(field: String, predicate: (String) -> Boolean) = ev[field]?.any { predicate(it.s("text", 160)) } == true
    val t = o.o("transaction"); val amount = java.math.BigDecimal(o.getLong("amountMinor")).movePointLeft(2).toPlainString()
    val negative = Regex("未|待|失败|退款|退还|撤销|关闭|(?i)unpaid|not paid|pending|refund|failed|cancel")
    val contradicted = listOf("amountMinor", "paymentStatus").any { field -> ev[field]?.any { negative.containsMatchIn(it.s("text", 160)) } == true }
    val money = match("amountMinor") { Regex("(?<![0-9.+-])" + Regex.escape(amount) + "(?![0-9.])").containsMatchIn(it) }
    val paid = match("paymentStatus") { Regex("支付成功|付款成功|交易成功|(?i)\\bpaid\\b|payment successful").containsMatchIn(it) }
    val fullTransaction = t.s("id", 128).matches(Regex("[A-Za-z0-9][A-Za-z0-9:_-]{7,127}")) &&
      !Regex("未知|不详|未识别|(?i)unknown|n/a|masked").containsMatchIn(t.s("paymentProvider"))
    val currency = match("currency") { (Regex("\\bCNY\\b").containsMatchIn(it) || it.contains("人民币")) && Regex("\\b[A-Z]{3}\\b").findAll(it).all { token -> token.value == "CNY" } }
    return if (!contradicted && fullTransaction && money && paid && currency && match("merchant") { it == o.s("merchant") } && match("transactionId") { it == t.s("id", 128) } && match("paymentProvider") { it == t.s("paymentProvider") }) "confirmed" else "pending_confirmation"
  }
  fun frameGuard(metadata: JSONObject, sessionId: String?, generation: Long, age: Long) {
    demand(metadata.s("sessionId", 128) == sessionId && metadata.int("generation", 1) == generation, "STALE_GENERATION")
    demand(age in 0..20000, "STALE_FRAME")
  }
}

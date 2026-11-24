package expo.modules.jarviscompanion

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Rect
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.util.UUID

/** 仅使用冻结的合成fixture及内存SQLite，不启动服务、授权页或联网。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CompanionNativeTest {
  private class Clock : TimeSource {
    var wall = 1700000000000L
    var mono = 100000L
    var boot = "synthetic-boot-a"
    override fun wall() = wall
    override fun mono() = mono
    override fun boot() = boot
    fun advance(ms: Long) { wall += ms; mono += ms }
  }
  private lateinit var clock: Clock
  private lateinit var repo: LifeRepository
  private lateinit var fixtures: JSONObject
  private val context: Context get() = ApplicationProvider.getApplicationContext()
  @Before fun setup() {
    clock = Clock(); repo = LifeRepository(context, clock, null)
    fixtures = javaClass.classLoader!!.getResourceAsStream("companion-fixtures.json")!!.bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
    assertTrue(fixtures.getBoolean("synthetic"))
  }
  @After fun teardown() { repo.close() }
  private fun fresh() { repo.close(); clock = Clock(); repo = LifeRepository(context, clock, null) }
  private fun patch(base: JSONObject, changes: JSONObject?): JSONObject = base.copy().apply {
    changes?.keysSet()?.forEach { put(it, changes.get(it)) }
  }
  private fun fault(code: String, block: () -> Unit) {
    try { block(); fail("应拒绝：$code") } catch (e: Fault) { assertEquals(code, e.code) }
  }
  private fun command(kind: String, payload: JSONObject, ids: JSONArray = JSONArray(), op: String = UUID.randomUUID().toString()) =
    obj("schemaVersion" to 1, "opId" to op, "kind" to kind, "payload" to payload, "observationIds" to ids)
  private fun target(r: JSONObject, confirmed: Boolean = false): JSONObject = obj("recordId" to r.get("id"), "expectedRevision" to r.get("revision")).apply {
    if (confirmed) put("userConfirmed", true)
  }
  private fun model(id: String) = fixtures.a("modelCases").objects().first { it.s("id") == id }
  private fun metadata(frame: String = "synthetic-frame-a") = fixtures.o("metadata").copy().put("frameId", frame).put("capturedAt", clock.wall)
  private fun identified(output: JSONObject, meta: JSONObject): List<JSONObject> = output.a("observations").objects().mapIndexed { i, o ->
    o.copy().put("observationId", "obs_" + digest(JSONArray().put(meta.s("sessionId", 128)).put(meta.int("generation")).put(meta.s("frameId", 128)).put(i).toString()))
  }
  private fun response(output: JSONObject, meta: JSONObject) = obj("schemaVersion" to 1, "sessionId" to meta.get("sessionId"), "generation" to meta.get("generation"),
    "frameId" to meta.get("frameId"), "observations" to JSONArray(identified(output, meta)), "usage" to obj("inputTokens" to null, "outputTokens" to null, "totalTokens" to null))
  private fun commit(output: JSONObject, meta: JSONObject = metadata(), ctx: JSONObject = fixtures.o("nativeContext")): List<JSONObject> {
    val list = VisionRules.validateResponse(StrictJson.parse(response(output, meta).toString()), meta)
    return repo.commitVision(list, meta, ctx) {
      VisionRules.frameGuard(meta, ctx.nullableText("activeSessionId", 128), ctx.int("activeGeneration"), ctx.int("frameAgeMs"))
    }
  }
  private fun subset(expected: JSONObject, actual: JSONObject) {
    expected.keysSet().forEach { key -> assertEquals(key, canonical(expected.get(key)), canonical(actual.get(key))) }
  }
  private fun runFixture(case: JSONObject, output: JSONObject, inherited: JSONObject? = null) {
    fresh()
    val meta = patch(fixtures.o("metadata"), case.optJSONObject("metadataOverride"))
    val ctx = patch(patch(fixtures.o("nativeContext"), inherited), case.optJSONObject("contextOverride"))
    val beforeContext = canonical(ctx)
    val expected = case.o("expected")
    if (!expected.bool("accepted")) {
      fault(expected.s("errorCode")) { commit(output, meta, ctx) }
      assertEquals(0L, repo.revision()); assertTrue(repo.records().isEmpty())
    } else {
      commit(output, meta, ctx)
      val records = repo.records()
      assertEquals(output.a("observations").length(), records.size)
      expected.optJSONArray("records")?.objects()?.forEachIndexed { i, record -> subset(record, records[i]) }
      if (expected.has("recordStatus")) assertEquals(expected.s("recordStatus"), records.single().s("status"))
      if (expected.has("confirmedExpenseCount")) assertEquals(expected.getInt("confirmedExpenseCount"), records.count { it.s("kind") == "expense" && it.s("status") == "confirmed" })
      assertEquals(beforeContext, canonical(ctx))
      assertFalse(records.any { it.has("actions") || it.has("commands") || it.has("apiKey") || it.has("image") })
    }
  }
  @Test fun allModelAndVariantFixturesReachNativeRepository() {
    val cases = fixtures.a("modelCases").objects(); assertEquals(9, cases.size)
    cases.forEach { runFixture(it, it.o("output")) }
    val variants = fixtures.a("variantCases").objects(); assertEquals(11, variants.size)
    variants.forEach { variant ->
      val base = model(variant.s("modelCaseId")); val output = base.o("output").copy()
      output.a("observations").put(0, patch(output.a("observations").getJSONObject(0), variant.o("observationPatch")))
      runFixture(variant, output, base.optJSONObject("contextOverride"))
    }
  }
  @Test fun upstreamFinalContentAndStrictJsonRejectMalformedOrExecutableFields() {
    fixtures.a("upstreamCases").objects().filter { it.s("finishReason") == "stop" }.forEach { case ->
      fault("INVALID_SCHEMA") { VisionRules.validateModel(StrictJson.parse(case.getString("rawContent")), "mixed") }
      assertEquals(0L, repo.revision())
    }
    listOf("{\"x\":1,\"x\":2}", "{\"x\":NaN}", "{\"x\":9007199254740992}", "{\"x\":9007199254740991.1}", "{\"x\":9007199254740990.5}", "{\"x\":1e-999}", "{\"x\":1} trailing").forEach { raw -> fault("INVALID_SCHEMA") { StrictJson.parse(raw) } }
    val wrongDate = model("food-visible-quantity").o("output").copy()
    wrongDate.a("observations").getJSONObject(0).put("expiresOn", "2025-02-30")
    fault("INVALID_SCHEMA") { commit(wrongDate) }
    val extra = model("food-visible-quantity").o("output").copy().put("actions", JSONArray())
    fault("INVALID_SCHEMA") { VisionRules.validateModel(extra, "mixed") }
    val excessive = response(model("food-visible-quantity").o("output"), metadata())
    excessive.o("usage").put("outputTokens", 769)
    fault("INVALID_SCHEMA") { VisionRules.validateResponse(excessive, metadata()) }
  }
  @Test fun idempotencyFixtureCommandsEventsAndAcksNeverDoubleWrite() {
    val scenario = fixtures.o("idempotencyScenario")
    assertEquals(scenario.int("initialRevision"), repo.revision())
    var first: JSONObject? = null
    val projection = linkedMapOf<String, JSONObject>()
    val seen = hashSetOf<String>()
    scenario.a("steps").objects().forEach { step ->
      val before = repo.revision()
      val action = {
        when (step.s("operation")) {
          "submitCommand" -> {
            val input = scenario.o("command").copy()
            input.put("payload", patch(input.o("payload"), step.optJSONObject("payloadPatch")))
            val receipt = repo.submit(input)
            if (first == null) first = receipt
            assertEquals(step.bool("expectedReplayed"), receipt.bool("replayed"))
            assertEquals(first!!.s("eventId"), receipt.s("eventId"))
            assertEquals(first!!.getLong("revision"), receipt.getLong("revision"))
          }
          "deliverEvent" -> {
            val event = scenario.o("committedEvent")
            if (seen.add(event.s("eventId"))) event.o("change").o("record").let { projection[it.id("id")] = it }
            assertEquals(step.getInt("expectedProjectedRecords"), projection.size)
            assertEquals(before, repo.revision())
          }
          "ackChanges" -> assertEquals(step.getLong("expectedAckedRevision"), repo.ack(step.int("revision")).getLong("ackedRevision"))
          else -> fail("fixture操作未实现")
        }
      }
      if (step.has("expectedErrorCode")) {
        if (step.s("operation") == "ackChanges") fault(step.s("expectedErrorCode")) { repo.ack(step.int("revision")) }
        else fault(step.s("expectedErrorCode"), action)
      } else action()
      if (step.has("expectedRevision")) assertEquals(step.int("expectedRevision"), repo.revision())
      if (step.has("expectedRecords")) assertEquals(step.getInt("expectedRecords"), repo.records().size)
    }
    fault("SNAPSHOT_REQUIRED") { repo.readChanges(0) }
    assertEquals(0, repo.readChanges(1).a("changes").length())
  }
  @Test fun allElevenCommandsAndExpectedRevisionUseSingleEvents() {
    val note = repo.submit(command("note.create", obj("text" to "合成笔记", "source" to "manual_action")))
    val expense = repo.submit(command("expense.create", obj("text" to "合成餐费", "amountMinor" to 1200, "currency" to "CNY", "purpose" to "午餐", "merchant" to null, "source" to "manual_voice")))
    val location = repo.submit(command("location.create", obj("text" to "合成地点", "latitude" to 30.0, "longitude" to 120.0, "accuracyMeters" to null, "capturedAt" to clock.wall, "userConfirmed" to true)))
    assertEquals(3L, repo.revision())
    val n = repo.record(note.a("recordIds").getString(0))
    fault("CONFLICT") { repo.submit(command("record.revoke", target(n, true).put("expectedRevision", 0))) }
    repo.submit(command("record.revoke", target(n, true)))
    repo.submit(command("record.delete", target(repo.record(location.a("recordIds").getString(0)), true)))
    val output = model("food-visible-quantity").o("output")
    commit(output)
    val food = repo.records().single { it.s("kind") == "foodObservation" }
    val facts = obj("kind" to "foodObservation", "name" to food.get("name"), "brand" to null, "barcode" to null, "quantity" to food.get("quantity"), "expiresOn" to null)
    repo.submit(command("record.confirm", target(food, true).put("facts", facts), food.a("observationIds")))
    val timer = repo.submit(command("pomodoro.start", obj("text" to "合成专注", "phase" to "focus", "durationMs" to 1500000, "source" to "manual_action")))
    val timerId = timer.a("recordIds").getString(0)
    clock.advance(1000); repo.submit(command("pomodoro.pause", target(repo.record(timerId))))
    clock.advance(5000); repo.submit(command("pomodoro.resume", target(repo.record(timerId))))
    repo.submit(command("pomodoro.finish", target(repo.record(timerId))))
    assertEquals(1000L, repo.record(timerId).o("clock").getLong("elapsedActiveMs"))
    assertEquals(5000L, repo.record(timerId).o("clock").getLong("accumulatedPausedMs"))
    val before = repo.revision()
    repo.submit(command("life.clear", obj("scope" to "all", "expectedRevision" to before, "userConfirmed" to true)))
    assertEquals(before + 1, repo.revision()); assertTrue(repo.records().isEmpty())
    assertTrue(repo.submit(command("expense.create", obj("text" to "合成餐费", "amountMinor" to 1200, "currency" to "CNY", "purpose" to "午餐", "merchant" to null, "source" to "manual_voice"), op = expense.s("opId"))).bool("replayed"))
    assertTrue(repo.records().isEmpty())
  }
  @Test fun publicCannotForgeInternalSourcesObservationsOrForeignConfirmation() {
    val p = obj("text" to "合成伪造", "source" to "screen_observation")
    fault("INVALID_SCHEMA") { repo.submit(command("note.create", p)) }
    fault("INVALID_REQUEST") { repo.submit(command("note.create", p, op = "internal.synthetic")) }
    fault("INVALID_SCHEMA") { repo.submit(command("note.create", p.put("source", "manual_text"), JSONArray().put("forged-id"))) }
    commit(model("expense-foreign-currency-never-becomes-cny").o("output"))
    val foreign = repo.records().single()
    val facts = obj("kind" to "expense", "text" to "不能转换", "amountMinor" to 1299, "currency" to "CNY", "purpose" to "合成", "merchant" to null)
    fault("UNSUPPORTED_CURRENCY") { repo.submit(command("record.confirm", target(foreign, true).put("facts", facts))) }
    assertEquals("USD", repo.records().single().s("currency"))
  }
  @Test fun foodDedupDoesNotAccumulateAndDeletionKeepsTombstones() {
    val output = model("food-visible-quantity").o("output")
    commit(output); val first = repo.records().single()
    assertTrue(commit(output).isEmpty())
    for (i in 1..70) { clock.advance(1000); commit(output, metadata("synthetic-frame-$i")) }
    val updated = repo.records().single()
    assertEquals(first.id("id"), updated.id("id")); assertEquals(2, updated.o("quantity").getInt("value"))
    assertEquals(clock.wall, updated.getLong("lastSeenAt")); assertEquals(64, updated.a("observationIds").length())
    repo.submit(command("record.delete", target(updated, true)))
    val rev = repo.revision()
    assertTrue(commit(output, metadata("synthetic-frame-after-delete")).isEmpty())
    assertTrue(repo.records().isEmpty()); assertEquals(rev, repo.revision())
    fault("SNAPSHOT_REQUIRED") { repo.readChanges(rev - 1) }
  }
  @Test fun confirmedTransactionDedupDoesNotUseAmountMerchantOrTime() {
    val case = model("expense-cny-paid-auto-enabled-with-transaction")
    val ctx = patch(fixtures.o("nativeContext"), case.o("contextOverride"))
    val output = case.o("output").copy()
    commit(output, metadata(), ctx); commit(output, metadata("different-frame"), ctx)
    assertEquals(1, repo.records().size)
    val second = output.copy(); val o = second.a("observations").getJSONObject(0)
    o.o("transaction").put("id", "SYNTHETIC-TXN-0002")
    o.a("evidence").objects().first { it.s("field") == "transactionId" }.put("text", "SYNTHETIC-TXN-0002")
    commit(second, metadata("second-transaction"), ctx)
    assertEquals(2, repo.records().size)
    repo.submit(command("life.clear", obj("scope" to "all", "expectedRevision" to repo.revision(), "userConfirmed" to true)))
    val rev = repo.revision(); commit(output, metadata("after-clear"), ctx)
    assertEquals(rev, repo.revision()); assertTrue(repo.records().isEmpty())
  }
  @Test fun correctedFoodIdentityKeepsAliasesWithoutChangingOriginalEvidence() {
    val output = model("food-visible-quantity").o("output").copy(); commit(output)
    val first = repo.records().single()
    val facts = obj("kind" to "foodObservation", "name" to "合成青苹果", "brand" to null, "barcode" to null, "quantity" to null, "expiresOn" to null)
    repo.submit(command("record.confirm", target(first, true).put("facts", facts)))
    val confirmed = repo.records().single()
    assertEquals(canonical(first.a("evidence")), canonical(confirmed.a("evidence")))
    output.a("observations").getJSONObject(0).put("name", "合成青苹果")
    commit(output, metadata("corrected-name"))
    val updated = repo.records().single()
    assertEquals(first.id("id"), updated.id("id")); assertEquals("confirmed", updated.s("status")); assertTrue(updated.isNull("quantity"))
    assertEquals(canonical(first.o("source")), canonical(updated.o("source")))
    repo.submit(command("record.delete", target(updated, true)))
    assertTrue(commit(output, metadata("new-name-tombstone")).isEmpty())
    assertTrue(commit(model("food-visible-quantity").o("output"), metadata("old-name-tombstone")).isEmpty())
    assertTrue(repo.records().isEmpty())
  }
  @Test fun pendingTransactionsStayRetiredAfterDeleteRevokeAndClear() {
    listOf("record.delete", "record.revoke", "life.clear").forEach { operation ->
      fresh(); val output = model("expense-cny-paid-auto-enabled-with-transaction").o("output")
      commit(output); val pending = repo.records().single(); assertEquals("pending_confirmation", pending.s("status"))
      val payload = if (operation == "life.clear") obj("scope" to "all", "expectedRevision" to repo.revision(), "userConfirmed" to true) else target(pending, true)
      repo.submit(command(operation, payload)); val revision = repo.revision()
      assertTrue(commit(output, metadata("retired-transaction")).isEmpty()); assertEquals(revision, repo.revision())
      if (operation == "record.revoke") assertEquals("revoked", repo.records().single().s("status")) else assertTrue(repo.records().isEmpty())
    }
  }
  @Test fun entireFrameRollbackIncludesReceiptsAndDedupIndexes() {
    val output = model("food-visible-quantity").o("output").copy()
    val other = output.a("observations").getJSONObject(0).copy().put("name", "合成梨")
    output.a("observations").put(other)
    val list = identified(output, metadata()); var checks = 0
    fault("STALE_GENERATION") { repo.commitVision(list, metadata(), fixtures.o("nativeContext")) { checks++; if (checks == 2) throw Fault("STALE_GENERATION") } }
    assertEquals(0L, repo.revision()); assertTrue(repo.records().isEmpty()); assertEquals(0, repo.readChanges(0).a("changes").length())
    assertEquals(2, commit(output).size); assertEquals(2L, repo.revision())
    val bad = output.copy(); bad.a("observations").getJSONObject(1).put("actions", JSONArray())
    fault("INVALID_SCHEMA") { commit(bad, metadata("invalid-batch")) }
    assertEquals(2L, repo.revision())
  }
  private fun config(): JSONObject {
    val provider = obj("purpose" to "vision", "preset" to "qwen", "baseUrl" to "https://dashscope.aliyuncs.com/compatible-mode/v1", "model" to "qwen3-vl-plus", "thinking" to "disabled", "credentialSource" to "vision")
    return obj("schemaVersion" to 1, "backendOrigin" to "https://synthetic.invalid", "provider" to provider,
      "credentialBinding" to obj("credentialId" to "synthetic-slot", "credentialRevision" to 1), "taskMode" to "mixed",
      "cloudConsent" to obj("accepted" to true, "acceptedAt" to clock.wall, "provider" to provider.copy(), "backendOrigin" to "https://synthetic.invalid", "reuseChatKeyAccepted" to false),
      "autoConfirmExpenses" to false, "autoConfirmExpensesAcceptedAt" to null, "budget" to obj("sessionDurationMs" to 1800000, "maxSessionAttempts" to 40, "maxDailyAttempts" to 100), "budgetAcceptedAt" to null, "foodContextId" to "synthetic-fridge-a")
  }
  private fun key() = obj("credentialId" to "synthetic-slot", "credentialRevision" to 1, "apiKey" to "synthetic-placeholder-not-a-real-key")
  private fun activeMeta(machine: ObservationMachine) = metadata().put("sessionId", machine.session!!.get("sessionId")).put("generation", machine.generation)
  @Test fun stopDuringAuthorizationInvalidatesLateCallbacksAndCredentials() {
    val machine = ObservationMachine(repo); val c = config(); machine.start(c, key())
    val pendingGeneration = machine.generation
    fault("ALREADY_RUNNING") { machine.start(c, key()) }
    assertEquals(pendingGeneration, machine.generation)
    val receipt = machine.stop("credentials_changed")
    assertEquals(pendingGeneration, receipt.getLong("invalidatedGeneration")); assertNull(machine.credentials); assertNull(machine.config)
    fault("STALE_GENERATION") { machine.ready() }
    val stoppedGeneration = machine.generation
    assertTrue(machine.stop("user").isNull("invalidatedGeneration")); assertEquals(stoppedGeneration, machine.generation)
    machine.start(c, key()); machine.ready(); val meta = activeMeta(machine)
    machine.stop("stop_all")
    fault("STALE_GENERATION") { machine.guard(meta, clock.mono) }
    assertEquals(0L, repo.revision())
  }
  @Test fun attemptsPersistBeforeSendingAndFinalBudgetResponseMayCommit() {
    val machine = ObservationMachine(repo); val c = config()
    c.o("budget").put("maxSessionAttempts", 1); c.put("budgetAcceptedAt", clock.wall)
    machine.start(c, key()); machine.ready(); val meta = activeMeta(machine)
    machine.reserveAttempt(meta, clock.mono)
    assertEquals("1", repo.meta("dailyAttempts")); assertEquals("1", repo.meta("sessionAttempts"))
    assertEquals("session_limit", machine.limitReason()); assertNull(machine.limitReason(false))
    val captured = clock.mono
    machine.guard(meta, captured)
    val receipts = repo.commitVision(identified(model("food-visible-quantity").o("output"), meta), meta, c) { machine.guard(meta, captured) }
    assertEquals(1, receipts.size); assertEquals(1L, repo.revision())
    clock.advance(8000)
    fault("LIMIT_REACHED") { machine.reserveAttempt(meta, captured) }
    assertEquals("1", repo.meta("dailyAttempts"))
    machine.stop("session_limit")
    val recreated = ObservationMachine(repo)
    assertEquals(1, recreated.snapshot().o("counters").getInt("dailyAttempts"))
    assertEquals(1, recreated.sessionAttempts)
  }
  @Test fun requestSpacingFailureBudgetFrameAgeAndSessionDuration() {
    val machine = ObservationMachine(repo); machine.start(config(), key()); machine.ready()
    val meta = activeMeta(machine); val captured = clock.mono
    machine.reserveAttempt(meta, captured); assertFalse(machine.canAttempt())
    clock.advance(7999); assertFalse(machine.canAttempt()); clock.advance(1); assertTrue(machine.canAttempt())
    machine.reserveAttempt(meta, captured)
    assertFalse(machine.failed()); assertFalse(machine.failed()); assertTrue(machine.failed()); machine.succeeded(); assertEquals(0, machine.failures)
    clock.advance(12001); fault("STALE_FRAME") { machine.guard(meta, captured) }
    clock.advance(1800000); assertEquals("session_limit", machine.limitReason(false))
    val rebuilt = ObservationMachine(repo)
    assertEquals("stopped", rebuilt.state); assertEquals("service_recreated", rebuilt.reason); assertNull(rebuilt.credentials)
  }
  @Test fun clockAnomalyPreservesDailyBudgetAndHasConservativeRecovery() {
    var machine = ObservationMachine(repo); machine.start(config(), key()); machine.ready()
    machine.reserveAttempt(activeMeta(machine), clock.mono); machine.stop("user")
    clock.wall -= 3600000
    fault("CLOCK_UNCERTAIN") { machine.start(config(), key()) }
    assertEquals("1", repo.meta("dailyAttempts"))
    machine.start(config(), key()); machine.stop("user")
    clock.advance(2 * 86400000L)
    machine.start(config(), key()); assertEquals("0", repo.meta("dailyAttempts")); machine.ready()
    machine.reserveAttempt(activeMeta(machine), clock.mono); machine.stop("user")
    clock.boot = "synthetic-boot-b"; clock.mono = 1000; clock.wall += 86400000L
    machine = ObservationMachine(repo)
    fault("CLOCK_UNCERTAIN") { machine.start(config(), key()) }
    assertEquals("1", repo.meta("dailyAttempts")); machine.start(config(), key())
    assertEquals("1", repo.meta("dailyAttempts")); machine.stop("user")
  }
  @Test fun allConsentAndTrustedTransportBoundariesAreIndependent() {
    val c = config()
    fault("AUTH_REQUIRED") { ObservationValidation.validate(c, key().put("credentialRevision", 2)) }
    fault("CONSENT_REQUIRED") { ObservationValidation.validate(c.copy().apply { o("cloudConsent").put("accepted", false) }, key()) }
    fault("CONSENT_REQUIRED") { ObservationValidation.validate(c.copy().apply { o("cloudConsent").put("backendOrigin", "https://other.invalid") }, key()) }
    fault("INVALID_SCHEMA") { ObservationValidation.validate(c.copy().put("systemGranted", true), key()) }
    fixtures.a("transportBoundaryCases").objects().filter { it.has("backendOrigin") }.forEach { case ->
      fault(case.s("expectedErrorCode")) { ObservationValidation.origin(case.s("backendOrigin")) }
    }
    listOf("https://127.0.0.1", "https://name.local", "https://user@synthetic.invalid", "https://synthetic.invalid/path", "https://synthetic.invalid?x=1", "https://synthetic.invalid:8443").forEach { origin ->
      fault("INSECURE_TRANSPORT") { ObservationValidation.origin(origin) }
    }
  }
  @Test fun timerPauseResumeFinishAndClockDiscontinuitiesAreAuthoritative() {
    fun start(): String = repo.submit(command("pomodoro.start", obj("text" to "合成番茄", "phase" to "break", "durationMs" to 300000, "source" to "manual_action"))).a("recordIds").getString(0)
    var id = start(); clock.advance(10000)
    repo.submit(command("pomodoro.pause", target(repo.record(id)))); clock.advance(300000)
    assertEquals(10000L, TimerClock.elapsed(repo.record(id), clock)); assertTrue(repo.reconcileTimers().isEmpty())
    repo.submit(command("pomodoro.resume", target(repo.record(id)))); clock.advance(290000)
    assertEquals(1, repo.reconcileTimers().size); assertEquals("completed", repo.record(id).s("finishReason")); assertTrue(repo.reconcileTimers().isEmpty())
    id = start(); clock.wall += 121000
    repo.reconcileTimers(); assertEquals("interrupted", repo.record(id).s("timerState"))
    fault("CLOCK_UNCERTAIN") { repo.submit(command("pomodoro.resume", target(repo.record(id)))) }
    repo.submit(command("pomodoro.finish", target(repo.record(id))))
    assertEquals("user", repo.record(id).s("finishReason")); assertEquals("needs_review", repo.record(id).s("clockIntegrity"))
    id = start(); clock.boot = "synthetic-boot-c"; clock.mono = 0; repo.reconcileTimers()
    assertEquals("interrupted", repo.record(id).s("timerState")); assertTrue(repo.record(id).isNull("finishedAt"))
  }
  @Test @Config(sdk = [24, 25]) @GraphicsMode(GraphicsMode.Mode.LEGACY)
  fun lifeAndTimerRemainAvailableBeforeNotificationChannels() {
    ServiceNotifications.channel(context, "jarvis_timer", "合成计时")
    ServiceNotifications.allowed(context, "jarvis_timer")
    val output = model("food-visible-quantity").o("output").copy()
    val food = output.a("observations").getJSONObject(0)
    food.put("expiresOn", "2024-02-29").a("evidence").put(obj("field" to "expiresOn", "kind" to "visible_text", "text" to "2024-02-29"))
    commit(output); assertEquals("2024-02-29", repo.records().single().s("expiresOn"))
    val timer = repo.submit(command("pomodoro.start", obj("text" to "合成旧版计时", "phase" to "focus", "durationMs" to 1000, "source" to "manual_action")))
    clock.advance(1000); repo.reconcileTimers()
    assertEquals("completed", repo.record(timer.a("recordIds").getString(0)).s("finishReason"))
    assertEquals("2023-11-14", utcDay(1700000000000L))
  }
  @Test fun snapshotAndIncrementalPagesRecoverWithoutInventingRevisions() {
    repeat(101) { repo.submit(command("note.create", obj("text" to "合成$it", "source" to "manual_text"))) }
    val page = repo.readChanges(0); assertEquals(100, page.a("changes").length()); assertTrue(page.bool("hasMore"))
    val rest = repo.readChanges(page.int("throughRevision")); assertEquals(1, rest.a("changes").length()); assertFalse(rest.bool("hasMore"))
    val snapshot = repo.snapshot(obj("running" to false), ObservationMachine(repo).snapshot())
    assertEquals(101L, snapshot.int("revision")); assertEquals(101, snapshot.a("records").length())
    repo.ack(snapshot.int("revision")); assertEquals(101L, repo.revision())
    fault("INVALID_REVISION") { repo.readChanges(102) }
  }
  private fun bitmap(invert: Boolean = false, edge: Int = 64): Bitmap = Bitmap.createBitmap(edge, edge, Bitmap.Config.ARGB_8888).apply {
    for (y in 0 until edge) for (x in 0 until edge) {
      val g = if (invert) 255 - (x * 255 / edge) else x * 255 / edge
      setPixel(x, y, Color.rgb(g, g, g))
    }
  }
  @Test fun stableFramesLatestOnlyMaskMotionAndBitmapOwnership() {
    val pipeline = FramePipeline()
    assertFalse(pipeline.accept(bitmap(), metadata(), clock.mono, null))
    assertTrue(pipeline.accept(bitmap(), metadata(), clock.mono, null))
    val first = pipeline.take()!!; assertFalse(first.bitmap.isRecycled); pipeline.markAttempt(first); first.close()
    assertFalse(pipeline.accept(bitmap(), metadata(), clock.mono, null))
    assertFalse(pipeline.accept(bitmap(), metadata(), clock.mono, Rect(4, 4, 12, 12)))
    assertFalse(pipeline.accept(bitmap(), metadata(), clock.mono, Rect(16, 16, 24, 24)))
    assertFalse(pipeline.accept(bitmap(true), metadata(), clock.mono, null))
    assertTrue(pipeline.accept(bitmap(true), metadata(), clock.mono, null)); assertNotNull(pipeline.latest)
    pipeline.dropPending(); assertNull(pipeline.latest); pipeline.reset()
    repeat(4) { pipeline.accept(Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888), metadata(), clock.mono, null) }
    fault("NO_USABLE_PREVIEW") { pipeline.accept(Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888), metadata(), clock.mono, null) }
    pipeline.reset()
  }
  @Test fun staticBufferCanStabilizeWithoutRefreshingItsCaptureTime() {
    val pipeline = FramePipeline(); val captured = clock.mono
    assertFalse(pipeline.accept(bitmap(), metadata(), captured, null)); assertNull(pipeline.take())
    clock.advance(999); pipeline.unchanged(clock.mono); assertNull(pipeline.take())
    clock.advance(1); pipeline.unchanged(clock.mono)
    val stable = pipeline.take()!!; assertEquals(captured, stable.mono)
    pipeline.markAttempt(stable); stable.close()
    repeat(30) { clock.advance(1000); pipeline.unchanged(clock.mono); assertNull(pipeline.take()) }
    pipeline.reset()
    pipeline.accept(Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888), metadata(), clock.mono, null)
    repeat(3) { pipeline.unchanged(clock.mono) }
    fault("NO_USABLE_PREVIEW") { pipeline.unchanged(clock.mono) }
    pipeline.reset()
  }
  @Test fun producerTimestampCannotRefreshAnOldOrUnknownFrame() {
    val nowNs = 100000000000L
    assertEquals(99500L, FramePipeline.capturedMono(nowNs - 500000000L, nowNs, 100000L))
    assertEquals(80000L, FramePipeline.capturedMono(nowNs - 20000000000L, nowNs, 100000L))
    assertEquals(99999L, FramePipeline.capturedMono(nowNs - 1, nowNs, 100000L))
    listOf(0L, nowNs + 1, nowNs - 20000000001L).forEach { timestamp ->
      fault("NO_USABLE_PREVIEW") { FramePipeline.capturedMono(timestamp, nowNs, 100000L) }
    }
  }
  @Test fun generatedJpegIsBoundedDecodableAndHasNoDataPrefix() {
    val input = bitmap(edge = 2048)
    val image = FramePipeline.image(input)
    val encoded = image.s("base64", 273068)
    assertFalse(encoded.startsWith("data:")); assertFalse(encoded.contains('\n'))
    val bytes = Base64.decode(encoded, Base64.NO_WRAP); assertTrue(bytes.size <= 204800)
    val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)!!
    assertEquals(image.getInt("width"), decoded.width); assertTrue(maxOf(decoded.width, decoded.height) <= 1024)
    decoded.recycle(); assertFalse(input.isRecycled); input.recycle()
  }
}

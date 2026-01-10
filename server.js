// server.js
import express from "express";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

// ───────────────────────────────────────────────────────────────────────────────
// 0) HELPERS
// ───────────────────────────────────────────────────────────────────────────────
function normalizePhone(phone = "") {
  const digits = String(phone).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return digits;
  return digits;
}

function wantsHumanFromText(text = "") {
  return /(operator|representative|human|real person|agent|someone|talk to a person|call me)/i.test(text);
}

function looksLikeYes(text = "") {
  return /^(yes|yeah|yep|correct|right|that’s right|thats right|affirmative|sure|ok|okay)\b/i.test(text.trim());
}

function looksLikeNo(text = "") {
  return /^(no|nope|not really|wrong|incorrect)\b/i.test(text.trim());
}

function extractZip(text = "") {
  const m = String(text).match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
}

function extractName(text = "") {
  const raw = String(text).trim();
  if (!raw) return "";

  // strip punctuation around words (so "Tom." becomes "Tom")
  const cleaned = raw.replace(/[^A-Za-z\s']/g, " ").replace(/\s+/g, " ").trim();

  // “my name is ___”, “this is ___”, “i'm ___”
  const m = cleaned.match(/\b(my name is|this is|i am|i'm|im)\s+([A-Za-z]{2,}(?:\s+[A-Za-z]{2,})?)\b/i);
  if (m?.[2]) return m[2].trim();

  // Single first name only (avoid grabbing sentences)
  if (/^[A-Za-z]{2,}$/.test(cleaned) && cleaned.length <= 20) return cleaned;

  return "";
}

function extractCarYear(text = "") {
  const m = String(text).match(/\b(19\d{2}|20[0-2]\d)\b/);
  return m ? m[1] : "";
}

function extractCarMakeModel(text = "") {
  const cleaned = String(text)
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // "1992 Ford Explorer" -> "Ford Explorer"
  const m1 = cleaned.match(/\b(19\d{2}|20[0-2]\d)\s+([A-Za-z]+)\s+([A-Za-z0-9]+)\b/);
  if (m1) return `${m1[2]} ${m1[3]}`.trim();

  // "Ford Explorer"
  const m2 = cleaned.match(/\b([A-Za-z]+)\s+([A-Za-z0-9]+)\b/);
  if (m2) return `${m2[1]} ${m2[2]}`.trim();

  return "";
}

function speakZipDigits(zip = "") {
  // 02321 -> "zero two three two one"
  return String(zip)
    .split("")
    .map((d) => (d === "0" ? "zero" : d))
    .join(" ");
}

// Issue routing (keyword-based; tune freely)
function categorizeIssue(text = "") {
  const t = String(text).toLowerCase();

  if (/(won't start|wont start|no start|clicking|starter|dead battery|jump start)/i.test(t)) return "no_start";
  if (/(overheat|overheating|temperature gauge|coolant|radiator|steam)/i.test(t)) return "overheating";
  if (/(brake|grind|squeal|squeak|pedal|rotor)/i.test(t)) return "brakes";
  if (/(pulls to the (right|left)|pulling|alignment|steering wheel|drifts)/i.test(t)) return "pulling_alignment";
  if (/(check engine|cel|engine light|code|misfire|rough idle)/i.test(t)) return "check_engine";
  if (/(transmission|slipping|hard shift|won't shift|gear)/i.test(t)) return "transmission";
  if (/(ac|a\/c|air conditioner|no cold|blowing warm)/i.test(t)) return "ac";
  if (/(battery|alternator|charging|lights dim|electrical)/i.test(t)) return "electrical";
  if (/(flat tire|tire|puncture|blowout)/i.test(t)) return "tire";
  if (/(noise|rattle|clunk|knock)/i.test(t)) return "noise";
  return "general";
}

// Map voice category -> leads.service_type (so you have something consistent)
function serviceTypeFromCategory(cat = "general") {
  const map = {
    brakes: "brake-repair",
    pulling_alignment: "alignment-steering",
    no_start: "no-start-battery-starter",
    overheating: "cooling-system",
    check_engine: "check-engine-diagnostics",
    transmission: "transmission",
    ac: "ac-repair",
    electrical: "electrical",
    tire: "tire-service",
    noise: "noise-diagnosis",
    general: "general-repair",
  };
  return map[cat] || "general-repair";
}

const FOLLOWUP_BY_CATEGORY = {
  brakes: "Are you hearing squeaking or grinding, and does it happen only when braking or all the time?",
  pulling_alignment: "Does it pull mostly at higher speeds, and does the steering wheel shake or feel off-center?",
  no_start: "When you turn the key, do you hear a click, a crank, or nothing at all? And are the dash lights on?",
  overheating: "Has the temp gauge gone into the red, or have you seen steam or coolant leaks? How long into driving does it happen?",
  check_engine: "Is the car running rough or losing power? And is the light flashing or solid?",
  transmission: "Is it slipping, shifting hard, or refusing to go into gear? Any warning lights?",
  ac: "Is it blowing warm air constantly or only at idle? Any unusual noises when the AC is on?",
  electrical: "Are you seeing dimming lights, a battery warning, or intermittent power issues? When did it start?",
  tire: "Is the tire flat right now, or losing air slowly?",
  noise: "Is it more like a clunk/knock/rattle, and does it happen over bumps, turning, or accelerating?",
  general: "What’s the make and model of the car?",
};

// ───────────────────────────────────────────────────────────────────────────────
// 1) CONFIGURATION & SETUP
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const {
  OPENAI_API_KEY,
  DEEPGRAM_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  SUPABASE_URL,
  SUPABASE_KEY,
  PUBLIC_BASE_URL,
  ADMIN_ESCALATION_PHONE,
} = process.env;

if (
  !OPENAI_API_KEY ||
  !DEEPGRAM_API_KEY ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER ||
  !SUPABASE_URL ||
  !SUPABASE_KEY
) {
  console.error("❌ CRITICAL: Missing required env vars.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ───────────────────────────────────────────────────────────────────────────────
// 2) HEALTH CHECK
// ───────────────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("MassMechanic Server is Awake 🤖"));

// ───────────────────────────────────────────────────────────────────────────────
// 3) TWILIO VOICE WEBHOOKS
// ───────────────────────────────────────────────────────────────────────────────
function getStreamUrl(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const xfProto = req.headers["x-forwarded-proto"] || "https";
  const proto = String(xfProto).includes("https") ? "wss" : "ws";
  return `${proto}://${host}/`;
}

app.post("/voice", (req, res) => {
  res.type("text/xml");

  const streamUrl = getStreamUrl(req);
  const from = normalizePhone(req.body?.From || "");
  const caller = normalizePhone(req.body?.Caller || "");
  const callSid = req.body?.CallSid || "";

  res.send(`
    <Response>
      <Connect>
        <Stream url="${streamUrl}">
          <Parameter name="from" value="${from}" />
          <Parameter name="caller" value="${caller}" />
          <Parameter name="callSid" value="${callSid}" />
        </Stream>
      </Connect>
    </Response>
  `);
});

app.post("/transfer", (req, res) => {
  res.type("text/xml");

  if (!ADMIN_ESCALATION_PHONE) {
    return res.send(`
      <Response>
        <Say>Sorry, no operator is available right now.</Say>
        <Hangup/>
      </Response>
    `);
  }

  return res.send(`
    <Response>
      <Say>Connecting you now.</Say>
      <Dial timeout="25" answerOnBridge="true">${ADMIN_ESCALATION_PHONE}</Dial>
      <Say>Sorry — nobody answered. Please text us and we will follow up.</Say>
      <Hangup/>
    </Response>
  `);
});

// Your greeting (as requested)
const VOICE_GREETING =
  "Thanks for calling Mass Mechanic. Tell me what's going on with your car and I'll get you matched with a trusted local mechanic for free.";

// ───────────────────────────────────────────────────────────────────────────────
// 4) SPEAK + LOGGING HELPERS
// ───────────────────────────────────────────────────────────────────────────────
function estimateSpeakMs(text = "") {
  // crude but good enough to avoid talking over the user:
  // ~15 chars/sec + min clamp
  const ms = Math.max(900, Math.min(9000, Math.ceil(String(text).length / 15) * 1000));
  return ms;
}

async function speakOverStream({ ws, streamSid, text, deepgramKey }) {
  const ttsResponse = await fetch(
    "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mulaw&sample_rate=8000&container=none",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${deepgramKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    }
  );

  if (!ttsResponse.ok) {
    const errText = await ttsResponse.text().catch(() => "");
    console.error("❌ TTS Failed:", ttsResponse.status, errText);
    return false;
  }

  const audioBuffer = await ttsResponse.arrayBuffer();
  const base64Audio = Buffer.from(audioBuffer).toString("base64");

  if (ws.readyState === WebSocket.OPEN && streamSid) {
    ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64Audio } }));
    return true;
  }
  return false;
}

async function transferCallToHuman(callSid) {
  if (!ADMIN_ESCALATION_PHONE) return console.error("❌ Missing ADMIN_ESCALATION_PHONE");
  if (!callSid) return console.error("❌ Missing callSid — cannot transfer");

  const baseUrl = PUBLIC_BASE_URL || "https://mass-mechanic-bot.onrender.com";
  const transferUrl = `${baseUrl}/transfer`;

  await twilioClient.calls(callSid).update({ url: transferUrl, method: "POST" });
  console.log("📞 Call transfer initiated", { callSid, transferUrl });
}

// call_outcomes: create/update row (FIXED: caller_phone column name)
async function upsertCallOutcome({ callSid, patch }) {
  if (!callSid) return;

  try {
    // 1) Try update first
    const { data: updated, error: updErr } = await supabase
      .from("call_outcomes")
      .update({ ...patch })
      .eq("call_sid", callSid)
      .select("id")
      .limit(1);

    if (updErr) {
      console.error("⚠️ call_outcomes update failed:", updErr.message);
      // fall through to insert attempt
    }

    if (updated && updated.length > 0) return; // success

    // 2) If nothing updated (row doesn't exist), insert
    const { error: insErr } = await supabase
      .from("call_outcomes")
      .insert({ call_sid: callSid, ...patch });

    if (insErr) console.error("⚠️ call_outcomes insert failed:", insErr.message);
  } catch (e) {
    console.error("⚠️ call_outcomes upsert exception:", e);
  }
}

// Create a lead in Supabase after confirmation (FIX: car_make_model non-null)
async function createLeadFromCall({ callerPhone, state }) {
  try {
    const payload = {
      service_type: serviceTypeFromCategory(state.issueCategory),
      zip_code: state.zip,
      car_make_model: state.carMakeModel || "Unknown",
      car_year: state.carYear || null,
      description: state.issueText || "",
      name: state.name || null,
      phone: callerPhone || null,
      lead_source: "voice",
      status: "new",
      lead_category: "repair", // optional; your send-lead function skips "maintenance"
      drivable: state.drivable || null,
      urgency_window: state.urgency_window || null,
    };

    const { data, error } = await supabase.from("leads").insert(payload).select("id, lead_code").maybeSingle();
    if (error) {
      console.error("❌ Lead insert failed:", error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true, lead: data };
  } catch (e) {
    console.error("❌ Lead insert exception:", e);
    return { ok: false, error: e?.message || "unknown" };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 5) WEBSOCKET SERVER FOR TWILIO MEDIA STREAMS
// ───────────────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => console.log(`✅ MassMechanic Running on ${PORT}`));
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  console.log("🔗 Voice Connected");

  let streamSid = null;
  let deepgramLive = null;

  let greeted = false;
  let transferred = false;

  let callerPhone = "unknown";
  let callSid = "";

  // Turn-taking / anti-interrupt guardrails
  let isSpeaking = false;
  let speakUntilTs = 0;
  let processing = false;
  let pendingFinal = null;
  let lastFinalAt = 0;

  const state = {
    name: "",
    zip: "",
    issueText: "",
    issueCategory: "general",
    askedFollowup: false,
    awaitingConfirmation: false,
    confirmed: false,
    carMakeModel: "",
    carYear: "",
    // optional: if you later add these questions
    drivable: "",
    urgency_window: "",
    leadCreated: false,
  };

  // Keep GPT as “backup”, but prefer deterministic questions to reduce weirdness
  const messages = [
    {
      role: "system",
      content:
        "You are the MassMechanic phone agent. Keep replies SHORT (1 sentence). Ask ONE question at a time. " +
        "Goal: collect (1) what's wrong, (2) ZIP code, (3) first name, (4) car make/model (year optional). " +
        "Do NOT ask for last name. Do NOT end the call until you confirm the details. " +
        "If user says 'no' to confirmation, ask what to correct and then re-confirm.",
    },
  ];

  const setupDeepgram = () => {
    deepgramLive = new WebSocket(
      "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&model=nova-2&smart_format=true",
      { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
    );

    deepgramLive.on("open", () => console.log("🟢 Deepgram Listening"));

    deepgramLive.on("message", async (data) => {
      if (transferred) return;

      let received;
      try {
        received = JSON.parse(data);
      } catch {
        return;
      }

      const transcript = received.channel?.alternatives?.[0]?.transcript;
      if (!transcript) return;

      // Only act on final transcripts
      if (!received.is_final) return;

      const text = transcript.trim();
      if (!text) return;

      // Debounce / prevent rapid-fire finals causing talk-over
      const now = Date.now();
      lastFinalAt = now;
      pendingFinal = text;

      // If currently speaking or processing, wait and process latest
      if (processing) return;
      if (isSpeaking && now < speakUntilTs) return;

      await drainPendingFinal();
    });

    deepgramLive.on("error", (err) => console.error("DG Error:", err));
  };

  setupDeepgram();

  function readyToConfirm() {
    // Require carMakeModel so lead insert doesn't violate NOT NULL
    return Boolean(state.issueText && state.zip && state.name && state.carMakeModel);
  }

  async function say(text) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !streamSid) return;

    // Mark speaking to reduce user-talk-over
    isSpeaking = true;
    const ms = estimateSpeakMs(text);
    speakUntilTs = Date.now() + ms;

    const ok = await speakOverStream({ ws, streamSid, text, deepgramKey: DEEPGRAM_API_KEY });
    if (!ok) {
      // if TTS fails, stop "speaking" state quickly
      speakUntilTs = Date.now() + 300;
    }

    // Release speaking flag after estimated duration
    setTimeout(() => {
      isSpeaking = false;
    }, ms);
  }

  async function drainPendingFinal() {
    if (!pendingFinal) return;
    processing = true;

    try {
      // Grab the most recent final utterance and clear queue
      const text = pendingFinal;
      pendingFinal = null;

      console.log(`🗣️ User: ${text}`);

      // Human escalation
      if (wantsHumanFromText(text)) {
        transferred = true;

        await upsertCallOutcome({
          callSid,
          patch: {
            caller_phone: callerPhone,
            name: state.name || null,
            zip_code: state.zip || null,
            issue_text: state.issueText || null,
            issue_category: state.issueCategory || null,
            confirmed: false,
            outcome: "transfer_requested",
            notes: "User requested a human",
            source: "voice",
          },
        });

        await say("Got it — connecting you to an operator now.");
        await transferCallToHuman(callSid);

        try {
          if (deepgramLive) deepgramLive.close();
        } catch {}
        try {
          ws.close();
        } catch {}
        return;
      }

      // ALWAYS attempt extraction (independent of other heuristics)
      if (!state.zip) {
        const z = extractZip(text);
        if (z) state.zip = z;
      }
      if (!state.name) {
        const n = extractName(text);
        if (n) state.name = n;
      }
      if (!state.carYear) {
        const y = extractCarYear(text);
        if (y) state.carYear = y;
      }
      if (!state.carMakeModel) {
        const mm = extractCarMakeModel(text);
        if (mm) state.carMakeModel = mm;
      }

      // Capture issueText once (avoid overwriting with name/zip)
      if (!state.issueText) {
        const z = extractZip(text);
        const n = extractName(text);
        const mm = extractCarMakeModel(text);

        // If utterance is not just zip/name/vehicle, treat as issue
        if (!z && !n && !mm && text.length > 6) {
          state.issueText = text;
          state.issueCategory = categorizeIssue(text);
        }

        // If user says "my car is pulling to the right" etc, we still want to capture issue
        if (!state.issueText && text.length > 6 && !z && !n) {
          // allow vehicle phrases to also be issue sometimes — but only if it contains problem keywords
          if (/(pull|brake|start|overheat|check engine|noise|shake|vibration|ac|battery|transmission|stall)/i.test(text)) {
            state.issueText = text;
            state.issueCategory = categorizeIssue(text);
          }
        }
      }

      // If awaiting confirmation, handle yes/no deterministically
      if (state.awaitingConfirmation && !state.confirmed) {
        if (looksLikeYes(text)) {
          state.confirmed = true;
          state.awaitingConfirmation = false;

          // Log call_outcomes (confirmed)
          await upsertCallOutcome({
            callSid,
            patch: {
              caller_phone: callerPhone,
              name: state.name || null,
              zip_code: state.zip || null,
              issue_text: state.issueText || null,
              issue_category: state.issueCategory || null,
              confirmed: true,
              outcome: "confirmed",
              notes: "Confirmed details on call",
              source: "voice",
            },
          });

          // Create lead (if not created already)
          if (!state.leadCreated) {
            const leadRes = await createLeadFromCall({ callerPhone, state });
            if (leadRes.ok) {
              state.leadCreated = true;
              console.log("✅ Lead created from voice:", leadRes.lead);
            }
          }

          await say(
            `Perfect — thanks, ${state.name}. We'll connect you with a trusted local mechanic near ZIP ${speakZipDigits(
              state.zip
            )}.`
          );
          return;
        }

        if (looksLikeNo(text)) {
          state.awaitingConfirmation = false;
          await say("No problem — what should I correct: your ZIP code, your name, the car, or the issue?");
          return;
        }
        // unclear -> fall through
      }

      // Deterministic follow-ups to reduce “AI weirdness”
      if (state.issueText && !state.askedFollowup) {
        state.askedFollowup = true;
        const followup = FOLLOWUP_BY_CATEGORY[state.issueCategory] || FOLLOWUP_BY_CATEGORY.general;
        await say(followup);
        return;
      }

      // Ask missing fields in a stable order (issue -> zip -> name -> car)
      if (!state.issueText) {
        await say("Tell me what’s going on with your car.");
        return;
      }

      if (!state.zip) {
        await say("What’s your 5-digit ZIP code?");
        return;
      }

      if (!state.name) {
        await say("And what’s your first name?");
        return;
      }

      if (!state.carMakeModel) {
        await say("What’s the make and model of the car?");
        return;
      }

      // Confirmation (pronounce ZIP with leading zeros)
      if (readyToConfirm() && !state.confirmed && !state.awaitingConfirmation) {
        state.awaitingConfirmation = true;

        const zipSpoken = speakZipDigits(state.zip);
        const carSpoken = `${state.carYear ? state.carYear + " " : ""}${state.carMakeModel}`.trim();

        await say(
          `To confirm: you're in ZIP ${zipSpoken}, the car is a ${carSpoken}, and the issue is "${state.issueText}". Is that right?`
        );
        return;
      }

      // Backup GPT only if we somehow get here (should be rare)
      messages.push({ role: "user", content: text });

      const gpt = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            ...messages,
            {
              role: "system",
              content:
                `State: name="${state.name}", zip="${state.zip}", car="${state.carYear} ${state.carMakeModel}", ` +
                `issue="${state.issueText}", category="${state.issueCategory}". ` +
                `Ask ONE short question that collects missing info or confirms details. Do not ask last name.`,
            },
          ],
          max_tokens: 90,
        }),
      });

      const gptJson = await gpt.json();
      const aiText = gptJson?.choices?.[0]?.message?.content?.trim();

      if (!aiText) {
        await say("I’m having a quick technical issue. Please text us your ZIP and what’s going on, and we’ll follow up right away.");
        return;
      }

      messages.push({ role: "assistant", content: aiText });
      console.log(`🤖 AI: ${aiText}`);
      await say(aiText);
    } catch (e) {
      console.error("AI/TTS Error:", e);
      try {
        await say("Sorry — I had a quick technical glitch. Please text us your ZIP and car issue, and we’ll follow up right away.");
      } catch {}
    } finally {
      processing = false;

      // If another final came in while processing, handle it now (latest wins)
      if (pendingFinal && !transferred) {
        // small delay to avoid instant overlap with TTS
        setTimeout(() => {
          if (!processing && !(isSpeaking && Date.now() < speakUntilTs)) {
            drainPendingFinal();
          }
        }, 250);
      }
    }
  }

  ws.on("message", async (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      const params = data.start?.customParameters || {};

      const pFrom = normalizePhone(params.from || "");
      const pCaller = normalizePhone(params.caller || "");
      callerPhone = pFrom || pCaller || "unknown";
      callSid = params.callSid || data.start.callSid || callSid;

      console.log("☎️ Stream start", { streamSid, callSid, callerPhone });

      // Create/initialize call_outcomes row (FIX: caller_phone column)
      await upsertCallOutcome({
        callSid,
        patch: {
          caller_phone: callerPhone,
          source: "voice",
          outcome: "in_progress",
          confirmed: false,
          notes: null,
        },
      });

      if (!greeted) {
        greeted = true;
        await say(VOICE_GREETING);
      }
      return;
    }

    if (data.event === "media" && deepgramLive?.readyState === WebSocket.OPEN) {
      deepgramLive.send(Buffer.from(data.media.payload, "base64"));
      return;
    }

    if (data.event === "stop") {
      // Finalize call outcome if still in progress
      await upsertCallOutcome({
        callSid,
        patch: {
          caller_phone: callerPhone,
          name: state.name || null,
          zip_code: state.zip || null,
          issue_text: state.issueText || null,
          issue_category: state.issueCategory || null,
          confirmed: !!state.confirmed,
          outcome: state.confirmed ? "completed" : transferred ? "transferred" : "ended_unconfirmed",
          notes: state.confirmed ? "Call completed after confirmation" : "Call ended before confirmation",
          source: "voice",
        },
      });

      try {
        if (deepgramLive) deepgramLive.close();
      } catch {}
      return;
    }
  });

  ws.on("close", async () => {
    try {
      if (deepgramLive) deepgramLive.close();
    } catch {}

    // Best-effort finalize if socket closes unexpectedly
    await upsertCallOutcome({
      callSid,
      patch: {
        caller_phone: callerPhone,
        name: state.name || null,
        zip_code: state.zip || null,
        issue_text: state.issueText || null,
        issue_category: state.issueCategory || null,
        confirmed: !!state.confirmed,
        outcome: state.confirmed ? "completed" : transferred ? "transferred" : "socket_closed",
        notes: state.confirmed ? "Socket closed after confirmation" : "Socket closed before confirmation",
        source: "voice",
      },
    });
  });
});

import express from "express";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

// ───────────────────────────────────────────────────────────────
// 0) HELPERS
// ───────────────────────────────────────────────────────────────
function normalizePhone(phone = "") {
  const digits = String(phone).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `1${digits}`;
  return digits;
}

function normalizeZip(zip = "") {
  const m = String(zip).match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
}

// Speak ZIP as digits: "02321" => "0 2 3 2 1"
function zipToSpokenDigits(zip5 = "") {
  const z = normalizeZip(zip5);
  if (!z) return "";
  return z.split("").join(" ");
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
  return normalizeZip(text);
}

function extractName(text = "") {
  // "my name is Bob", "this is Bob"
  const m = text.match(/\b(my name is|this is|i'm|im)\s+([A-Za-z]+)\b/i);
  if (m?.[2]) return m[2].trim();

  // Single first name like "Bob."
  const t = text.trim().replace(/[^\w\s'-]/g, "");
  if (/^[A-Za-z]{2,20}$/.test(t)) return t;

  return "";
}

function extractCarMakeModel(text = "") {
  // crude but effective: "1992 Ford Explorer", "Toyota Camry", etc.
  const m = text.match(
    /\b(19\d{2}|20\d{2})?\s*(ford|toyota|honda|chevy|chevrolet|nissan|bmw|audi|jeep|hyundai|kia|subaru|mazda|volkswagen|vw)\s+[a-z0-9]+/i
  );
  return m ? m[0].trim() : "";
}

// Issue routing (keyword-based)
function categorizeIssue(text = "") {
  const t = text.toLowerCase();

  if (/(won't start|wont start|no start|clicking|starter|dead battery|jump start)/i.test(t)) return "no_start";
  if (/(overheat|overheating|temperature gauge|coolant|radiator|steam)/i.test(t)) return "overheating";
  if (/(brake|grind|squeal|squeak|pedal|rotor)/i.test(t)) return "brakes";
  if (/(pulls to the (right|left)|pulling|alignment|steering wheel|drifts)/i.test(t)) return "pulling_alignment";
  if (/(check engine|cel|engine light|code|misfire|rough idle)/i.test(t)) return "check_engine";
  if (/(transmission|slipping|hard shift|won't shift|gear)/i.test(t)) return "transmission";
  if (/(ac|a\/c|air conditioner|no cold|blowing warm)/i.test(t)) return "ac";
  if (/(battery|alternator|charging|lights dim|electrical)/i.test(t)) return "electrical";
  if (/(noise|rattle|clunk|knock)/i.test(t)) return "noise";
  if (/(flat tire|tire|puncture|blowout)/i.test(t)) return "tire";

  return "general";
}

const FOLLOWUP_BY_CATEGORY = {
  brakes: "Got it. Are you hearing squeaking or grinding, and does it happen only when braking?",
  pulling_alignment: "When it pulls, does the steering wheel shake or feel off-center?",
  no_start: "When you turn the key, do you hear a click, a crank, or nothing at all?",
  overheating: "Have you seen steam or coolant leaks, and how long into driving does it happen?",
  check_engine: "Is it running rough or losing power, and is the light flashing or solid?",
  transmission: "Is it slipping, shifting hard, or refusing to go into gear?",
  ac: "Is it blowing warm all the time or only at idle?",
  electrical: "Are the lights dimming or is there a battery warning light?",
  noise: "Is it more of a clunk/knock/rattle, and does it happen over bumps or while turning?",
  tire: "Is it flat right now, or losing air slowly?",
  general: "Got it. What’s the main symptom you’re noticing?"
};

// Optional: map issue_category -> service_type used by your leads table.
// Keep these matching what your form/edge expects.
const SERVICE_TYPE_BY_CATEGORY = {
  brakes: "brake-repair",
  pulling_alignment: "steering-suspension",
  no_start: "battery-starter-alternator",
  overheating: "cooling-system",
  check_engine: "check-engine-light",
  transmission: "transmission-repair",
  ac: "ac-repair",
  electrical: "electrical-diagnostics",
  noise: "diagnostic",
  tire: "tire-service",
  general: "diagnostic"
};

// ───────────────────────────────────────────────────────────────
// 1) APP SETUP
// ───────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const {
  OPENAI_API_KEY,
  DEEPGRAM_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  SUPABASE_URL,
  SUPABASE_KEY,
  PUBLIC_BASE_URL,
  ADMIN_ESCALATION_PHONE
} = process.env;

if (!DEEPGRAM_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ CRITICAL: Missing env vars");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

app.get("/", (_req, res) => res.send("MassMechanic Server is Awake 🤖"));

// ───────────────────────────────────────────────────────────────
// 2) TWILIO VOICE WEBHOOKS
// ───────────────────────────────────────────────────────────────
const VOICE_GREETING =
  "Thanks for calling MassMechanic. Tell me what’s going on with the car, and I’ll get you matched with a local mechanic.";

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

// ───────────────────────────────────────────────────────────────
// 3) DEEPGRAM TTS
// ───────────────────────────────────────────────────────────────
async function speakOverStream({ ws, streamSid, text, deepgramKey }) {
  const ttsResponse = await fetch(
    "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mulaw&sample_rate=8000&container=none",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${deepgramKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text })
    }
  );

  if (!ttsResponse.ok) {
    const errText = await ttsResponse.text().catch(() => "");
    console.error("❌ TTS Failed:", ttsResponse.status, errText);
    return;
  }

  const audioBuffer = await ttsResponse.arrayBuffer();
  const base64Audio = Buffer.from(audioBuffer).toString("base64");

  if (ws.readyState === WebSocket.OPEN && streamSid) {
    ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64Audio } }));
  }
}

async function transferCallToHuman(callSid) {
  if (!ADMIN_ESCALATION_PHONE) return console.error("❌ Missing ADMIN_ESCALATION_PHONE env var");
  if (!callSid) return console.error("❌ Missing callSid — cannot transfer");

  const baseUrl = PUBLIC_BASE_URL || "https://mass-mechanic-bot.onrender.com";
  const transferUrl = `${baseUrl}/transfer`;

  await twilioClient.calls(callSid).update({ url: transferUrl, method: "POST" });
  console.log("📞 Call transfer initiated", { callSid, transferUrl });
}

// ───────────────────────────────────────────────────────────────
// 4) CALL OUTCOME + LEAD CREATION
// ───────────────────────────────────────────────────────────────
async function insertCallOutcome({
  callSid,
  callerPhone,
  name,
  zip,
  issueText,
  issueCategory,
  confirmed,
  outcome,
  notes
}) {
  try {
    const payload = {
      call_sid: callSid || null,
      caller_phone: callerPhone || null, // ✅ correct column name
      name: name || null,
      zip_code: zip || null,
      issue_text: issueText || null,
      issue_category: issueCategory || null,
      confirmed: !!confirmed,
      outcome: outcome || null,
      notes: notes || null,
      source: "voice"
    };

    const { error } = await supabase.from("call_outcomes").insert(payload);
    if (error) console.error("⚠️ call_outcomes insert failed:", error.message);
  } catch (e) {
    console.error("⚠️ call_outcomes insert exception:", e?.message || e);
  }
}

async function createLeadAndDispatch({ callerPhone, name, zip, issueText, issueCategory, carMakeModel }) {
  const zip5 = normalizeZip(zip);
  const phoneDigits = String(callerPhone || "").replace(/\D/g, "");

  const serviceType =
    SERVICE_TYPE_BY_CATEGORY[issueCategory] ||
    SERVICE_TYPE_BY_CATEGORY.general;

  const leadPayload = {
    service_type: serviceType,
    zip_code: zip5,
    description: issueText,
    name: name || null,
    phone: phoneDigits || null,
    email: null,

    car_make_model: carMakeModel, // ✅ REQUIRED FIELD
    
    lead_source: "voice",
    lead_category: "repair",
    status: "new",

    lead_tier: "standard",
    lead_score_total: 0,

    drivable: null,
    urgency_window: null
  };

  const { data: lead, error } = await supabase
    .from("leads")
    .insert(leadPayload)
    .select("id, lead_code")
    .maybeSingle();

  if (error || !lead?.id) {
    console.error("❌ Lead insert failed:", error?.message || error);
    return { ok: false, error: error?.message || "lead_insert_failed" };
  }

  console.log("✅ Lead created:", { id: lead.id, lead_code: lead.lead_code, zip: zip5, service_type: serviceType });

  // Dispatch to mechanics (your edge function expects lead_id)
  try {
    const { error: invokeErr } = await supabase.functions.invoke("send-lead-to-mechanics", {
      body: { lead_id: lead.id }
    });
    if (invokeErr) console.error("⚠️ send-lead-to-mechanics failed:", invokeErr.message);
  } catch (e) {
    console.error("⚠️ send-lead-to-mechanics exception:", e?.message || e);
  }

  return { ok: true, lead };
}

// ───────────────────────────────────────────────────────────────
// 5) SERVER + WS UPGRADE
// ───────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => console.log(`✅ MassMechanic Running on ${PORT}`));
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// ───────────────────────────────────────────────────────────────
// 6) VOICE SESSION (STATE MACHINE CONTROLS FLOW)
// ───────────────────────────────────────────────────────────────
wss.on("connection", (ws) => {
  console.log("🔗 Voice Connected");

  let streamSid = null;
  let deepgramLive = null;
  let greeted = false;

  let callerPhone = "unknown";
  let callSid = "";
  let transferred = false;

  // Simple anti-overlap: if we just spoke, wait briefly before speaking again.
  let ttsBusy = false;
  async function safeSpeak(text) {
    if (!text) return;
    if (ttsBusy) return; // drop if already speaking (prevents stepping-on)
    ttsBusy = true;
    await speakOverStream({ ws, streamSid, text, deepgramKey: DEEPGRAM_API_KEY });
    // short cooldown
    setTimeout(() => (ttsBusy = false), 900);
  }

  const state = {
    name: "",
    zip: "",
    issueText: "",
    issueCategory: "general",
    carMakeModel: "",   // New
    askedFollowup: false,
    awaitingConfirmation: false,
    confirmed: false,
    leadCreated: false
  };

  function readyToConfirm() {
    return Boolean(state.issueText && state.zip && state.name);
  }

  function nextDeterministicQuestion() {
    // IMPORTANT: prevents loops
    if (!state.issueText) return "What problem are you having with the car?";
    if (!state.zip) return "What’s your 5 digit ZIP code?";
    if (!state.name) return "And what’s your first name?";
    return null;
  }

  function buildConfirmLine() {
    const zipSpoken = zipToSpokenDigits(state.zip);
    return `To confirm: ZIP ${zipSpoken}, and the issue is: ${state.issueText}. Is that correct?`;
  }

  const setupDeepgram = () => {
    deepgramLive = new WebSocket(
      "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&model=nova-2&smart_format=true",
      { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
    );

    deepgramLive.on("open", () => console.log("🟢 Deepgram Listening"));

    deepgramLive.on("message", (data) => {
      if (transferred) return;

      const received = JSON.parse(data);
      const transcript = received.channel?.alternatives?.[0]?.transcript;

      if (transcript && received.is_final && transcript.trim().length > 0) {
        console.log(`🗣️ User: ${transcript}`);
        processUserUtterance(transcript);
      }
    });

    deepgramLive.on("error", (err) => console.error("DG Error:", err));
  };

  setupDeepgram();

  async function processUserUtterance(text) {
    if (transferred) return;

    // Escalation
    if (wantsHumanFromText(text)) {
      transferred = true;
      await safeSpeak("Got it — connecting you to an operator now.");
      await transferCallToHuman(callSid);
      try { deepgramLive?.close(); } catch {}
      try { ws.close(); } catch {}
      return;
    }

    if (!state.carMakeModel) {
      const c = extractCarMakeModel(text);
      if (c) state.carMakeModel = c;
}
    // Extract + persist state (never clear fields once set)
    if (!state.name) {
      const n = extractName(text);
      if (n) state.name = n;
    }

    if (!state.zip) {
      const z = extractZip(text);
      if (z) state.zip = z;
    }

    // Capture issue only if it's not just a name/zip
    if (!state.issueText) {
      const looksLikeOnlyName = !!extractName(text) && text.trim().split(/\s+/).length <= 2;
      const looksLikeOnlyZip = !!extractZip(text) && text.trim().replace(/\D/g, "").length <= 5;
      if (!looksLikeOnlyName && !looksLikeOnlyZip && text.trim().length >= 6) {
        state.issueText = text.trim();
        state.issueCategory = categorizeIssue(state.issueText);
      }
    }

    // If awaiting confirmation, interpret yes/no
    if (state.awaitingConfirmation && !state.confirmed) {
      if (looksLikeYes(text)) {
        state.confirmed = true;
        state.awaitingConfirmation = false;

        // Log call outcome (confirmed)
        await insertCallOutcome({
          callSid,
          callerPhone,
          name: state.name,
          zip: state.zip,
          issueText: state.issueText,
          issueCategory: state.issueCategory,
          confirmed: true,
          outcome: "confirmed",
          notes: null
        });

        // Create lead + dispatch
        if (!state.leadCreated) {
          state.leadCreated = true;
          await createLeadAndDispatch({
            callerPhone,
            name: state.name,
            zip: state.zip,
            issueText: state.issueText,
            issueCategory: state.issueCategory
          });
        }

        await safeSpeak(`Perfect, ${state.name}. We’ll connect you with a local mechanic now. Thanks for calling MassMechanic!`);
        return;
      }

      if (looksLikeNo(text)) {
        state.awaitingConfirmation = false;
        await safeSpeak("No problem — what should I correct: the ZIP code, your first name, or the issue?");
        return;
      }

      // If unclear, re-ask confirmation once
      await safeSpeak(buildConfirmLine());
      return;
    }

    // Deterministic follow-up once we have issue
    if (state.issueText && !state.askedFollowup) {
      state.askedFollowup = true;
      const followup = FOLLOWUP_BY_CATEGORY[state.issueCategory] || FOLLOWUP_BY_CATEGORY.general;
      await safeSpeak(followup);
      return;
    }

    // Deterministic missing-field questions (prevents the name loop)
    const q = nextDeterministicQuestion();
    if (q) {
      await safeSpeak(q);
      return;
    }

    // If we have everything, move to confirmation
    if (readyToConfirm() && !state.confirmed && !state.awaitingConfirmation) {
      state.awaitingConfirmation = true;
      await safeSpeak(buildConfirmLine());
      return;
    }

    function nextDeterministicQuestion() {
      if (!state.issueText) return "What problem are you having with the car?";
      if (!state.zip) return "What’s your 5 digit ZIP code?";
      if (!state.carMakeModel) return "What’s the car’s make and model?";
      if (!state.name) return "And what’s your first name?";
      return null;
    }
    
    // Fallback: if somehow we’re here, ask the next deterministic question again
    const q2 = nextDeterministicQuestion();
    if (q2) await safeSpeak(q2);
  }

  ws.on("message", async (msg) => {
    const data = JSON.parse(msg);

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      const params = data.start?.customParameters || {};
      const pFrom = normalizePhone(params.from || "");
      const pCaller = normalizePhone(params.caller || "");
      callerPhone = pFrom || pCaller || "unknown";
      callSid = params.callSid || data.start.callSid || callSid;

      console.log("☎️ Stream start", { streamSid, callSid, callerPhone });

      if (!greeted) {
        greeted = true;
        await safeSpeak(VOICE_GREETING);
      }
      return;
    }

    if (data.event === "media" && deepgramLive?.readyState === WebSocket.OPEN) {
      deepgramLive.send(Buffer.from(data.media.payload, "base64"));
      return;
    }

    if (data.event === "stop") {
      try { deepgramLive?.close(); } catch {}
      return;
    }
  });

  ws.on("close", async () => {
    try { deepgramLive?.close(); } catch {}

    // Log incomplete call if we never confirmed
    if (!state.confirmed) {
      await insertCallOutcome({
        callSid,
        callerPhone,
        name: state.name || null,
        zip: state.zip || null,
        issueText: state.issueText || null,
        issueCategory: state.issueCategory || null,
        confirmed: false,
        outcome: "hangup_or_incomplete",
        notes: null
      });
    }
  });
});

import express from "express";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

// ───────────────────────────────────────────────────────────────────────────────
// 0. HELPERS
// ───────────────────────────────────────────────────────────────────────────────
function normalizePhone(phone = "") {
  const digits = String(phone).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `1${digits}`;
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

// Basic extraction helpers
function extractZip(text = "") {
  const m = text.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
}

function extractName(text = "") {
  const m = text.match(/\b(my name is|this is|i'm|im)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)\b/i);
  if (m?.[2]) return m[2].trim();
  if (/^[A-Za-z]{2,}(?:\s+[A-Za-z]{2,})?$/.test(text.trim()) && text.trim().length <= 20) {
    return text.trim();
  }
  return "";
}

// Issue routing (expanded keyword-based; tune freely)
function categorizeIssue(text = "") {
  const t = text.toLowerCase();

  // non-drivable / urgent
  if (/(won't start|wont start|no start|clicking|starter|dead battery|jump start|no crank|cranks but won't start)/i.test(t))
    return "no_start";
  if (/(overheat|overheating|temperature gauge|coolant|radiator|steam|hot smell)/i.test(t))
    return "overheating";
  if (/(brake|grind|squeal|squeak|pedal soft|pedal spongy|rotor|caliper|abs light)/i.test(t))
    return "brakes";
  if (/(pulls to the (right|left)|pulling|alignment|steering wheel|drifts|shakes at speed|vibration at speed)/i.test(t))
    return "pulling_alignment";
  if (/(check engine|cel|engine light|code|misfire|rough idle|stalling|hesitation|loss of power)/i.test(t))
    return "check_engine";
  if (/(transmission|slipping|hard shift|won't shift|gear|fluid leak transmission)/i.test(t))
    return "transmission";
  if (/(ac|a\/c|air conditioner|no cold|blowing warm|refrigerant|compressor)/i.test(t))
    return "ac";
  if (/(battery|alternator|charging|lights dim|electrical|short|fuse|parasitic drain)/i.test(t))
    return "electrical";
  if (/(noise|rattle|clunk|knock|squeak when turning|wheel bearing|humming|grinding while driving)/i.test(t))
    return "noise";
  if (/(flat tire|tire|puncture|blowout|nail in tire|tpms)/i.test(t))
    return "tire";
  if (/(oil leak|leaking oil|burning oil|low oil pressure|oil light)/i.test(t))
    return "oil_leak";
  if (/(coolant leak|leaking coolant|puddle green|puddle orange)/i.test(t))
    return "coolant_leak";
  if (/(smoke|smoking|burning smell|gas smell|fuel smell)/i.test(t))
    return "smoke_smell";
  if (/(suspension|control arm|strut|shock|ball joint|tie rod|cv axle|clicking when turning)/i.test(t))
    return "suspension_steering";
  if (/(battery light|abs light|traction control|stability control)/i.test(t))
    return "warning_lights";

  return "general";
}

const FOLLOWUP_BY_CATEGORY = {
  brakes: "Got it. Are you hearing squeaking or grinding, and does it happen only when braking or also while driving?",
  pulling_alignment: "When it pulls, is it mostly at higher speeds, and does the steering wheel shake or feel off-center?",
  no_start: "When you turn the key, do you hear a click, a crank, or nothing at all? And are the dash lights on?",
  overheating: "Has the temp gauge gone into the red or have you seen steam/coolant leaks? How long into driving does it happen?",
  check_engine: "Is the car running rough, shaking, or losing power? And is the light flashing or solid?",
  transmission: "Is it slipping, shifting hard, or refusing to go into gear? Any warning lights?",
  ac: "Is it blowing warm air constantly or only at idle? Any unusual noises when AC is on?",
  electrical: "Are you seeing dimming lights, warning lights, or intermittent power issues? When did it start?",
  noise: "Is the noise more like a clunk/knock/rattle, and does it happen over bumps, turning, or accelerating?",
  tire: "Is the tire flat right now, or losing air slowly? Is the car safe to drive at the moment?",
  oil_leak: "Are you seeing a puddle under the car, or is the oil level dropping on the dipstick? Any warning lights?",
  coolant_leak: "Are you seeing a puddle or smell coolant? Is the temperature climbing when you drive?",
  smoke_smell: "What color smoke is it (white/blue/black), and is there a strong burning or fuel smell?",
  suspension_steering: "Does it happen over bumps, during turns, or when accelerating? Any clicking when turning?",
  warning_lights: "Which light is on, and is it flashing or solid? Any change in how the car drives?",
  general: "Got it. What’s the make/model and roughly when did the issue start?"
};

// Map issueCategory -> leads.service_type (keep consistent with your app vocabulary)
const SERVICE_TYPE_BY_CATEGORY = {
  brakes: "brake-repair",
  pulling_alignment: "suspension-steering",
  no_start: "no-start-diagnostic",
  overheating: "cooling-system",
  check_engine: "check-engine-diagnostic",
  transmission: "transmission",
  ac: "ac-repair",
  electrical: "electrical-system",
  noise: "noise-diagnostic",
  tire: "tire-service",
  oil_leak: "oil-leak",
  coolant_leak: "coolant-leak",
  smoke_smell: "smoke-smell-diagnostic",
  suspension_steering: "suspension-steering",
  warning_lights: "warning-light-diagnostic",
  general: "general-diagnostic"
};

// Keep AI to ONE question (or one short statement). Truncate extra questions.
function enforceOneQuestion(text = "") {
  const t = String(text).trim();
  if (!t) return t;

  const qCount = (t.match(/\?/g) || []).length;
  if (qCount <= 1) return t;

  // Keep everything up to first '?'
  const idx = t.indexOf("?");
  return t.slice(0, idx + 1).trim();
}

// ───────────────────────────────────────────────────────────────────────────────
// 1. CONFIGURATION & SETUP
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
  ADMIN_ESCALATION_PHONE
} = process.env;

if (!OPENAI_API_KEY || !DEEPGRAM_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ CRITICAL: Missing API Keys.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ───────────────────────────────────────────────────────────────────────────────
// 2. HEALTH CHECK
// ───────────────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Mass Mechanic Server is Awake 🤖"));

// ────────────────────────────────────────────────────────────
// 4. VOICE SERVER
// ────────────────────────────────────────────────────────────
const VOICE_GREETING =
  "Thanks for calling MassMechanic — we connect you with trusted local mechanics for fast, free repair quotes. " +
  "Are you calling about a repair you need help with right now, or do you have a quick question?";

function getStreamUrl(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const xfProto = req.headers["x-forwarded-proto"] || "https";
  const proto = String(xfProto).includes("https") ? "wss" : "ws";
  return `${proto}://${host}/`;
}

// NOTE: speakOverStream is replaced at runtime per-connection with a “locked” version,
// because we need to estimate duration and allow barge-in.
async function baseSpeakOverStream({ ws, streamSid, text, deepgramKey }) {
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
    return { bytes: 0 };
  }

  const audioBuffer = await ttsResponse.arrayBuffer();
  const base64Audio = Buffer.from(audioBuffer).toString("base64");

  if (ws.readyState === WebSocket.OPEN && streamSid) {
    ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64Audio } }));
  }

  return { bytes: audioBuffer.byteLength };
}

async function sendVoiceEscalationSummary({ callerPhone, trigger, lastMessage }) {
  try {
    await supabase.functions.invoke("send-escalation-summary", {
      body: { phone: callerPhone, channel: "voice", trigger, last_message: lastMessage }
    });
    console.log("✅ Escalation summary invoked");
  } catch (e) {
    console.error("❌ send-escalation-summary failed:", e);
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

// ────────────────────────────────────────────────────────────
// 5. WEBSOCKET SERVER FOR TWILIO MEDIA STREAMS
// ────────────────────────────────────────────────────────────
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

  let callerPhone = "unknown";
  let callSid = "";
  let transferred = false;

  // TURN-TAKING / GUARDRAILS
  let isSpeaking = false;
  let pendingFinalText = "";
  let lastFinalText = "";
  let lastFinalAt = 0;
  let finalDebounceTimer = null;
  let inFlight = false; // hard block double-processing

  // Conversation state
  const state = {
    name: "",
    zip: "",
    issueText: "",
    issueCategory: "general",
    askedFollowup: false,
    awaitingConfirmation: false,
    confirmed: false
  };

  let messages = [
    {
      role: "system",
      content:
        "You are the MassMechanic phone agent. Keep answers SHORT (1–2 sentences). " +
        "Goal: collect Name, ZIP, and the car issue. Ask ONE question at a time. " +
        "Never output more than ONE question. " +
        "IMPORTANT: Do NOT end the call until you have CONFIRMED: Name + ZIP + Issue. " +
        "Before closing, ask: 'To confirm, you're in ZIP ___ and the issue is ___ — is that right?' " +
        "If the user says yes, close politely. If no, correct details and re-confirm. " +
        "The opening greeting has ALREADY been spoken, so do NOT repeat it."
    }
  ];

  function readyToConfirm() {
    return Boolean(state.name && state.zip && state.issueText);
  }

  function twilioClearAudio() {
    if (ws.readyState === WebSocket.OPEN && streamSid) {
      ws.send(JSON.stringify({ event: "clear", streamSid }));
    }
  }

  function isDuplicateFinal(text) {
    const now = Date.now();
    const normalized = String(text).trim().toLowerCase();
    if (normalized && normalized === lastFinalText && now - lastFinalAt < 1500) return true;
    lastFinalText = normalized;
    lastFinalAt = now;
    return false;
  }

  async function speakOverStreamWithLock(text) {
    const safeText = enforceOneQuestion(text);

    // speaking lock
    isSpeaking = true;

    const { bytes } = await baseSpeakOverStream({
      ws,
      streamSid,
      text: safeText,
      deepgramKey: DEEPGRAM_API_KEY
    });

    // mulaw 8kHz: ~8000 bytes/sec
    const durationSec = Math.max(0.35, bytes / 8000);

    setTimeout(() => {
      isSpeaking = false;

      // If caller spoke while we were talking, handle it now
      if (pendingFinalText && pendingFinalText.trim()) {
        const t = pendingFinalText;
        pendingFinalText = "";
        processAiResponse(t);
      }
    }, durationSec * 1000 + 250);
  }

  async function writeCallOutcome({ confirmed, outcome, notes }) {
    try {
      // You’ll create this table via Lovable prompt below
      const payload = {
        call_sid: callSid || null,
        caller_phone: callerPhone || null,
        name: state.name || null,
        zip_code: state.zip || null,
        issue_text: state.issueText || null,
        issue_category: state.issueCategory || null,
        confirmed: !!confirmed,
        outcome: outcome || null,
        notes: notes || null,
        source: "voice"
      };

      const { error } = await supabase.from("call_outcomes").insert(payload);
      if (error) console.error("❌ call_outcomes insert error:", error);
      else console.log("✅ call_outcomes inserted");
    } catch (e) {
      console.error("❌ writeCallOutcome exception:", e);
    }
  }

  async function createVoiceLeadAndDispatch() {
    try {
      // Create a lead for voice calls (since quoteform.tsx creates leads for web)
      // Normalize phone the same way your edge function expects (11 digits: 1XXXXXXXXXX)
      const phoneDb = normalizePhone(callerPhone);

      const service_type = SERVICE_TYPE_BY_CATEGORY[state.issueCategory] || "general-diagnostic";

      const leadInsert = {
        phone: phoneDb || null,
        zip_code: state.zip || null,
        service_type,
        description: state.issueText || null,
        lead_category: "repair",
        lead_tier: "med",
        drivable: "Unknown",
        urgency_window: "Unknown",
        // optional extras:
        car_year: null,
        car_make_model: null
      };

      const { data: lead, error: leadErr } = await supabase
        .from("leads")
        .insert(leadInsert)
        .select("id")
        .maybeSingle();

      if (leadErr || !lead?.id) {
        console.error("❌ Voice lead insert failed:", leadErr);
        return null;
      }

      console.log("✅ Voice lead created:", lead.id);

      // Kick the Edge Function that assigns + texts mechanics
      try {
        const { data, error } = await supabase.functions.invoke("send-lead-to-mechanics", {
          body: { lead_id: lead.id }
        });
        if (error) console.error("❌ send-lead-to-mechanics invoke error:", error);
        else console.log("✅ send-lead-to-mechanics invoked:", data);
      } catch (e) {
        console.error("❌ send-lead-to-mechanics invoke exception:", e);
      }

      return lead.id;
    } catch (e) {
      console.error("❌ createVoiceLeadAndDispatch exception:", e);
      return null;
    }
  }

  const setupDeepgram = () => {
    // NOTE: endpointing + interim results helps turn-taking
    deepgramLive = new WebSocket(
      "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&model=nova-2&smart_format=true&interim_results=true&endpointing=250&utterance_end_ms=1000",
      { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
    );

    deepgramLive.on("open", () => console.log("🟢 Deepgram Listening"));

    deepgramLive.on("message", (data) => {
      if (transferred) return;

      const received = JSON.parse(data);
      const alt = received.channel?.alternatives?.[0];
      const transcript = alt?.transcript?.trim() || "";
      if (!transcript) return;

      // BARGE-IN: if user is speaking while we are speaking, clear queued audio
      if (!received.is_final && isSpeaking) {
        twilioClearAudio();
        isSpeaking = false;
      }

      if (!received.is_final) return;

      if (isDuplicateFinal(transcript)) return;

      // Debounce finals: wait a beat for the utterance to settle
      pendingFinalText = transcript;
      if (finalDebounceTimer) clearTimeout(finalDebounceTimer);

      finalDebounceTimer = setTimeout(() => {
        const textToProcess = pendingFinalText;
        pendingFinalText = "";

        if (!textToProcess) return;

        // If AI is speaking, queue it; else process now
        if (isSpeaking) {
          pendingFinalText = textToProcess;
          return;
        }

        console.log(`🗣️ User: ${textToProcess}`);
        processAiResponse(textToProcess);
      }, 450);
    });

    deepgramLive.on("error", (err) => console.error("DG Error:", err));
  };

  setupDeepgram();

  const processAiResponse = async (text) => {
    if (inFlight) return;
    inFlight = true;

    try {
      if (transferred) return;

      // Human escalation
      if (wantsHumanFromText(text)) {
        transferred = true;
        console.log("🚨 Human requested — escalating", { callSid, callerPhone, text });

        await sendVoiceEscalationSummary({
          callerPhone,
          trigger: "REQUESTED_HUMAN",
          lastMessage: text
        });

        await speakOverStreamWithLock("Got it — connecting you to an operator now.");
        await transferCallToHuman(callSid);

        try { if (deepgramLive) deepgramLive.close(); } catch {}
        try { ws.close(); } catch {}
        return;
      }

      // Lightweight extraction from user input
      if (!state.zip) {
        const z = extractZip(text);
        if (z) state.zip = z;
      }
      if (!state.name) {
        const n = extractName(text);
        if (n) state.name = n;
      }

      // Capture issue text only if it looks like a description (not just name/zip)
      if (!state.issueText && text.length > 6) {
        if (!extractZip(text) && !extractName(text)) {
          state.issueText = text.trim();
          state.issueCategory = categorizeIssue(state.issueText);
        }
      }

      // If awaiting confirmation, interpret yes/no
      if (state.awaitingConfirmation && !state.confirmed) {
        if (looksLikeYes(text)) {
          state.confirmed = true;
          state.awaitingConfirmation = false;

          // Confirmation hook: write call_outcome + create lead + dispatch mechanics
          await writeCallOutcome({
            confirmed: true,
            outcome: "confirmed_details",
            notes: "Customer confirmed name/zip/issue on voice call"
          });

          await createVoiceLeadAndDispatch();

          const closing = `Perfect — thanks ${state.name || ""}. We’ll connect you with a local mechanic near ${state.zip}.`;
          messages.push({ role: "assistant", content: closing });
          await speakOverStreamWithLock(closing);
          return;
        }

        if (looksLikeNo(text)) {
          state.awaitingConfirmation = false;

          await writeCallOutcome({
            confirmed: false,
            outcome: "needs_correction",
            notes: "Customer said confirmation was incorrect"
          });

          const fix = "No problem — what should I correct: your ZIP code, your name, or the issue?";
          messages.push({ role: "assistant", content: fix });
          await speakOverStreamWithLock(fix);
          return;
        }
        // if unclear, fall through to GPT
      }

      messages.push({ role: "user", content: text });

      // Deterministic follow-up once issue captured
      if (state.issueText && !state.askedFollowup) {
        state.askedFollowup = true;
        const followup = FOLLOWUP_BY_CATEGORY[state.issueCategory] || FOLLOWUP_BY_CATEGORY.general;
        messages.push({ role: "assistant", content: followup });
        await speakOverStreamWithLock(followup);
        return;
      }

      // Force confirmation when ready
      if (readyToConfirm() && !state.confirmed && !state.awaitingConfirmation) {
        state.awaitingConfirmation = true;
        const confirmLine = `To confirm, you're in ZIP ${state.zip} and the issue is: ${state.issueText}. Is that right?`;
        messages.push({ role: "assistant", content: confirmLine });
        await speakOverStreamWithLock(confirmLine);
        return;
      }

      // Otherwise, use GPT to continue
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
                `Context (internal): name="${state.name}", zip="${state.zip}", issue_category="${state.issueCategory}", ` +
                `issue_text="${state.issueText}", askedFollowup=${state.askedFollowup}, awaitingConfirmation=${state.awaitingConfirmation}. ` +
                `Ask EXACTLY ONE short question that helps collect missing details. Do not ask two questions.`
            }
          ],
          max_tokens: 120
        })
      });

      const gptJson = await gpt.json();

      // Handle quota/rate-limit gracefully
      if (!gpt.ok) {
        console.error("❌ OpenAI error:", gpt.status, gptJson);
        const fallback =
          "I’m having a quick technical issue. Please visit massmechananic.com to submit your request, or text us your ZIP and the issue and we’ll follow up.";
        await speakOverStreamWithLock(fallback);
        await writeCallOutcome({
          confirmed: false,
          outcome: "ai_error",
          notes: `OpenAI error status=${gpt.status}`
        });
        return;
      }

      let aiText = gptJson?.choices?.[0]?.message?.content?.trim();
      aiText = enforceOneQuestion(aiText || "");

      if (!aiText) {
        const fallback =
          "I’m having a quick technical issue. Please visit massmechananic.com to submit your request, or text us your ZIP and the issue and we’ll follow up.";
        await speakOverStreamWithLock(fallback);
        await writeCallOutcome({
          confirmed: false,
          outcome: "empty_ai",
          notes: "No AI text returned"
        });
        return;
      }

      console.log(`🤖 AI: ${aiText}`);
      messages.push({ role: "assistant", content: aiText });
      await speakOverStreamWithLock(aiText);
    } catch (e) {
      console.error("AI/TTS Error:", e);
    } finally {
      inFlight = false;
    }
  };

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
        messages.push({ role: "assistant", content: VOICE_GREETING });
        await speakOverStreamWithLock(VOICE_GREETING);
      }
      return;
    }

    if (data.event === "media" && deepgramLive?.readyState === WebSocket.OPEN) {
      deepgramLive.send(Buffer.from(data.media.payload, "base64"));
      return;
    }

    if (data.event === "stop") {
      if (deepgramLive) deepgramLive.close();
      return;
    }
  });

  ws.on("close", () => {
    try { if (deepgramLive) deepgramLive.close(); } catch {}
  });
});

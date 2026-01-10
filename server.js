// server.js
// MassMechanic Voice Server (Twilio Media Streams + Deepgram STT/TTS + Supabase)
// Updates included:
// ✅ Speak ZIP digit-by-digit (leading zero preserved)
// ✅ Never ask for last name
// ✅ ZIP retry guardrail (max 2 misfires) -> offer/text fallback
// ✅ Log every call on hangup (call_outcomes best-effort)
// ✅ Create lead + dispatch to mechanics ONLY after explicit confirmation "YES"
// ✅ “Clear audio” before speaking (reduces talking-over)
// ✅ Confirmation loop tightened (won’t spiral forever)
// ✅ OpenAI failure fallback (still completes flow without crashing)

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

// Extract ZIP (5 digits)
function extractZip(text = "") {
  const m = text.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
}

// Extract a simple first name / short name
function extractName(text = "") {
  const m = text.match(/\b(my name is|this is|i'm|im)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)\b/i);
  if (m?.[2]) return m[2].trim();
  if (/^[A-Za-z]{2,}(?:\s+[A-Za-z]{2,})?$/.test(text.trim()) && text.trim().length <= 20) {
    return text.trim();
  }
  return "";
}

// Speak ZIP digit-by-digit so leading zeros are spoken
function speakZip(zip) {
  const z = String(zip || "").replace(/\D/g, "");
  if (z.length !== 5) return String(zip || "");
  return z.split("").join(" ");
}

// Normalize ZIP to 5 digits if possible (keeps leading zeros)
function normalizeZip(zip) {
  const z = String(zip || "").replace(/\D/g, "");
  if (z.length === 5) return z;
  return "";
}

// Issue routing (keyword-based; tune freely)
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
  brakes: "Got it. Are you hearing squeaking or grinding, and does it happen only when braking or all the time?",
  pulling_alignment: "When it pulls, is it mostly at higher speeds, and does the steering wheel shake or feel off-center?",
  no_start: "When you turn the key, do you hear a click, a crank, or nothing at all? And are the dash lights on?",
  overheating: "Has the temp gauge gone into the red or have you seen steam/coolant leaks? How long into driving does it happen?",
  check_engine: "Is the car running rough, shaking, or losing power? And is the light flashing or solid?",
  transmission: "Is it slipping, shifting hard, or refusing to go into gear? Any warning lights?",
  ac: "Is it blowing warm air constantly or only at idle? Any unusual noises when AC is on?",
  electrical: "Are you seeing dimming lights, battery warning, or intermittent power issues? When did it start?",
  noise: "Is the noise more like a clunk/knock/rattle, and does it happen over bumps, turning, or accelerating?",
  tire: "Is the tire flat right now, or losing air slowly?",
  general: "Got it. What’s the make/model and roughly when did the issue start?"
};

// Map issue category -> your lead service_type labels (edit these to match your DB exactly)
const SERVICE_TYPE_BY_CATEGORY = {
  brakes: "brake-repair",
  pulling_alignment: "suspension-steering",
  no_start: "starting-charging",
  overheating: "cooling-system",
  check_engine: "check-engine",
  transmission: "transmission-repair",
  ac: "ac-repair",
  electrical: "electrical-diagnosis",
  noise: "diagnostic",
  tire: "tire-service",
  general: "diagnostic"
};

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
  ADMIN_ESCALATION_PHONE,
  // Optional: where you want to send them to finish details by text
  QUOTE_FORM_URL // e.g. https://massmechanic.com/get-free-quotes
} = process.env;

if (!DEEPGRAM_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ CRITICAL: Missing required env vars.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ───────────────────────────────────────────────────────────────────────────────
// 2. HEALTH CHECK
// ───────────────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Mass Mechanic Server is Awake 🤖"));

// ────────────────────────────────────────────────────────────
// 3. TWILIO WEBHOOKS
// ────────────────────────────────────────────────────────────
const VOICE_GREETING =
  "Thanks for calling MassMechanic — we connect you with trusted local mechanics for fast, free repair quotes. " +
  "First, what’s your first name?";

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

// ────────────────────────────────────────────────────────────
// 4. VOICE CORE
// ────────────────────────────────────────────────────────────
async function sendSms(toE164DigitsOr11, body) {
  if (!TWILIO_PHONE_NUMBER) return;
  const toDigits = String(toE164DigitsOr11 || "").replace(/\D/g, "");
  if (!toDigits) return;

  // Twilio accepts E.164; we store callerPhone as 1XXXXXXXXXX
  const to = toDigits.length === 11 && toDigits.startsWith("1") ? `+${toDigits}` : `+1${toDigits}`;

  try {
    await twilioClient.messages.create({
      to,
      from: TWILIO_PHONE_NUMBER,
      body
    });
  } catch (e) {
    console.error("❌ SMS send failed:", e?.message || e);
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

// “Clear audio” reduces the bot talking over the caller if they start speaking mid-TTS
function clearTwilioAudio(ws, streamSid) {
  if (ws.readyState === WebSocket.OPEN && streamSid) {
    ws.send(JSON.stringify({ event: "clear", streamSid }));
  }
}

async function speakOverStream({ ws, streamSid, text, deepgramKey }) {
  // Clear buffered audio before speaking new prompt
  clearTwilioAudio(ws, streamSid);

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

// Best-effort: record call outcome
async function writeCallOutcome({ callSid, callerPhone, confirmed, outcome, name, zip, issueCategory, issueText, notes }) {
  try {
    const payload = {
      call_sid: callSid || null,
      phone: callerPhone || null,
      confirmed: !!confirmed,
      outcome: outcome || (confirmed ? "call_completed" : "call_ended"),
      name: name || null,
      zip_code: zip || null,
      issue_category: issueCategory || null,
      issue_text: issueText || null,
      notes: notes || null
    };

    const { error } = await supabase.from("call_outcomes").insert(payload);
    if (error) console.warn("⚠️ call_outcomes insert failed:", error.message);
  } catch (e) {
    console.warn("⚠️ call_outcomes insert exception:", e?.message || e);
  }
}

// Create a lead + invoke send-lead-to-mechanics edge function
async function createLeadAndDispatch({ callerPhone, name, zip, issueText, issueCategory }) {
  const zip5 = normalizeZip(zip);

  // Minimal lead insert (adjust columns to match your schema)
  const leadInsert = {
    source: "voice",
    phone: String(callerPhone || "").replace(/\D/g, ""), // e.g. 1XXXXXXXXXX
    customer_name: name || null,
    zip_code: zip5 || null,
    description: issueText || null,
    service_type: SERVICE_TYPE_BY_CATEGORY[issueCategory] || SERVICE_TYPE_BY_CATEGORY.general,
    lead_category: "repair" // keep consistent with your edge function skip logic
  };

  const { data: lead, error } = await supabase
    .from("leads")
    .insert(leadInsert)
    .select("id, lead_code")
    .maybeSingle();

  if (error || !lead?.id) {
    console.error("❌ Lead insert failed:", error?.message || "no lead returned");
    return { ok: false, error: error?.message || "lead_insert_failed" };
  }

  // Invoke your edge function to send lead to mechanics
  try {
    const { data: invokeData, error: invokeErr } = await supabase.functions.invoke("send-lead-to-mechanics", {
      body: { lead_id: lead.id }
    });
    if (invokeErr) {
      console.error("❌ send-lead-to-mechanics invoke failed:", invokeErr.message);
      return { ok: true, lead, dispatch_ok: false, dispatch_error: invokeErr.message };
    }
    return { ok: true, lead, dispatch_ok: true, dispatch_result: invokeData };
  } catch (e) {
    console.error("❌ send-lead-to-mechanics exception:", e?.message || e);
    return { ok: true, lead, dispatch_ok: false, dispatch_error: e?.message || "invoke_exception" };
  }
}

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

  let callerPhone = "unknown"; // stored as 1XXXXXXXXXX
  let callSid = "";
  let transferred = false;

  const state = {
    name: "",
    zip: "",
    zipAttempts: 0,
    issueText: "",
    issueCategory: "general",
    askedFollowup: false,
    awaitingConfirmation: false,
    confirmed: false,
    leadCreated: false
  };

  // Keep it simple, prevent model from adding “last name” nonsense
  const SYSTEM_RULES =
    "You are the MassMechanic phone agent. Keep answers SHORT (1–2 sentences). " +
    "Ask ONE question at a time. Do NOT ask for last name. " +
    "Goal: collect First Name, 5-digit ZIP, and a brief car issue. " +
    "After you have them, ask: 'To confirm, you're in ZIP ___ and the issue is ___ — is that right?' " +
    "If yes: thank them and say you're connecting them with a mechanic. If no: ask what to correct.";

  let messages = [{ role: "system", content: SYSTEM_RULES }];

  const setupDeepgram = () => {
    // NOTE: interim_results=true helps barge-in/turn-taking, but we only respond on is_final.
    deepgramLive = new WebSocket(
      "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&model=nova-2&smart_format=true&interim_results=true&endpointing=200",
      { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
    );

    deepgramLive.on("open", () => console.log("🟢 Deepgram Listening"));

    deepgramLive.on("message", (data) => {
      if (transferred) return;

      let received;
      try {
        received = JSON.parse(data);
      } catch {
        return;
      }

      const transcript = received.channel?.alternatives?.[0]?.transcript;

      // If user starts talking while bot audio is buffered, clear audio.
      if (transcript && !received.is_final && transcript.trim().length > 0) {
        clearTwilioAudio(ws, streamSid);
      }

      if (transcript && received.is_final && transcript.trim().length > 0) {
        console.log(`🗣️ User: ${transcript}`);
        processTurn(transcript);
      }
    });

    deepgramLive.on("error", (err) => console.error("DG Error:", err));
  };

  setupDeepgram();

  function readyToConfirm() {
    return Boolean(state.name && normalizeZip(state.zip) && state.issueText);
  }

  async function offerTextFallback(reason = "zip_trouble") {
    const formUrl = QUOTE_FORM_URL || "your booking form link";
    const msg =
      `No worries — you can text us your ZIP and a quick description, and we’ll connect you with a mechanic. ` +
      `Or use this form: ${formUrl}`;
    await speakOverStream({ ws, streamSid, text: msg, deepgramKey: DEEPGRAM_API_KEY });

    // If we know their number, also text them
    if (callerPhone && callerPhone !== "unknown") {
      await sendSms(callerPhone, `MassMechanic: Reply with your ZIP + what’s going on, or use: ${formUrl}`);
    }

    await writeCallOutcome({
      callSid,
      callerPhone,
      confirmed: false,
      outcome: "needs_text_followup",
      name: state.name,
      zip: normalizeZip(state.zip),
      issueCategory: state.issueCategory,
      issueText: state.issueText,
      notes: `Fallback offered: ${reason}`
    });
  }

  async function processTurn(text) {
    try {
      if (transferred) return;

      // Human escalation
      if (wantsHumanFromText(text)) {
        transferred = true;

        await speakOverStream({
          ws,
          streamSid,
          text: "Got it — connecting you to an operator now.",
          deepgramKey: DEEPGRAM_API_KEY
        });

        await transferCallToHuman(callSid);

        try { if (deepgramLive) deepgramLive.close(); } catch {}
        try { ws.close(); } catch {}
        return;
      }

      // If awaiting confirmation, interpret yes/no immediately
      if (state.awaitingConfirmation && !state.confirmed) {
        if (looksLikeYes(text)) {
          state.confirmed = true;
          state.awaitingConfirmation = false;

          // Log + create lead + dispatch exactly once
          if (!state.leadCreated) {
            state.leadCreated = true;

            await writeCallOutcome({
              callSid,
              callerPhone,
              confirmed: true,
              outcome: "call_completed",
              name: state.name,
              zip: normalizeZip(state.zip),
              issueCategory: state.issueCategory,
              issueText: state.issueText,
              notes: "Confirmed by caller"
            });

            // Create lead + dispatch
            await createLeadAndDispatch({
              callerPhone,
              name: state.name,
              zip: normalizeZip(state.zip),
              issueText: state.issueText,
              issueCategory: state.issueCategory
            });
          }

          const closing = `Perfect — thanks ${state.name}. We’ll connect you with a local mechanic near ZIP ${speakZip(
            normalizeZip(state.zip)
          )}.`;
          await speakOverStream({ ws, streamSid, text: closing, deepgramKey: DEEPGRAM_API_KEY });
          return;
        }

        if (looksLikeNo(text)) {
          state.awaitingConfirmation = false;
          const fix = "No problem — what should I correct: your ZIP code, your name, or the issue?";
          await speakOverStream({ ws, streamSid, text: fix, deepgramKey: DEEPGRAM_API_KEY });
          return;
        }
        // If unclear, continue below (but we’ll keep things tight)
      }

      // Lightweight extraction
      if (!state.name) {
        const n = extractName(text);
        if (n) state.name = n;
      }

      // ZIP handling with retries
      if (!normalizeZip(state.zip)) {
        const z = extractZip(text);
        if (z) state.zip = z;

        // If user *seems* to give a zip but we didn't get 5 digits, count attempts
        if (!z && /\b0?\d{3,5}\b/.test(text)) {
          state.zipAttempts += 1;
        }

        // Hard guardrail: after 2 zip misfires -> text fallback
        if (state.zipAttempts >= 2 && !normalizeZip(state.zip)) {
          await offerTextFallback("zip_retry_limit");
          return;
        }
      }

      // Issue capture (avoid overwriting once set)
      if (!state.issueText && text.length > 6) {
        // Avoid treating “Tom” or “02321” as issue
        const maybeZip = extractZip(text);
        const maybeName = extractName(text);
        if (!maybeZip && !maybeName) {
          state.issueText = text.trim();
          state.issueCategory = categorizeIssue(state.issueText);
        }
      }

      // Deterministic follow-up once we have an issue
      if (state.issueText && !state.askedFollowup) {
        state.askedFollowup = true;
        const followup = FOLLOWUP_BY_CATEGORY[state.issueCategory] || FOLLOWUP_BY_CATEGORY.general;
        await speakOverStream({ ws, streamSid, text: followup, deepgramKey: DEEPGRAM_API_KEY });
        return;
      }

      // Force confirmation once ready
      if (readyToConfirm() && !state.confirmed && !state.awaitingConfirmation) {
        state.awaitingConfirmation = true;
        const confirmLine = `To confirm, you're in ZIP ${speakZip(normalizeZip(state.zip))} and the issue is: ${
          state.issueText
        }. Is that right?`;
        await speakOverStream({ ws, streamSid, text: confirmLine, deepgramKey: DEEPGRAM_API_KEY });
        return;
      }

      // If something is missing, ask the next missing thing deterministically (avoid GPT weirdness)
      if (!state.name) {
        await speakOverStream({ ws, streamSid, text: "What’s your first name?", deepgramKey: DEEPGRAM_API_KEY });
        return;
      }
      if (!normalizeZip(state.zip)) {
        await speakOverStream({ ws, streamSid, text: "What’s your 5-digit ZIP code?", deepgramKey: DEEPGRAM_API_KEY });
        return;
      }
      if (!state.issueText) {
        await speakOverStream({ ws, streamSid, text: "What issue are you having with the car?", deepgramKey: DEEPGRAM_API_KEY });
        return;
      }

      // OPTIONAL: Use OpenAI only if you want extra nuance; otherwise deterministic is safer.
      // Keeping this as a best-effort, but NOT required for core flow.
      if (OPENAI_API_KEY) {
        messages.push({ role: "user", content: text });

        const gpt = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              ...messages,
              {
                role: "system",
                content:
                  `Internal context: name="${state.name}", zip="${normalizeZip(state.zip)}", issue="${state.issueText}". ` +
                  `Ask ONE short question to clarify the issue. Do NOT ask for last name.`
              }
            ],
            max_tokens: 90
          })
        });

        const gptJson = await gpt.json();
        const aiText = gptJson?.choices?.[0]?.message?.content?.trim();

        if (aiText) {
          messages.push({ role: "assistant", content: aiText });
          await speakOverStream({ ws, streamSid, text: aiText, deepgramKey: DEEPGRAM_API_KEY });
          return;
        }
      }

      // Fallback if GPT fails / disabled
      await speakOverStream({
        ws,
        streamSid,
        text: "Thanks — to confirm, can you repeat your ZIP and the main issue in one sentence?",
        deepgramKey: DEEPGRAM_API_KEY
      });
    } catch (e) {
      console.error("❌ processTurn error:", e?.message || e);
      await speakOverStream({
        ws,
        streamSid,
        text: "Sorry — quick technical issue. Please text us your ZIP and what’s going on and we’ll help right away.",
        deepgramKey: DEEPGRAM_API_KEY
      });
      if (callerPhone && callerPhone !== "unknown") {
        await sendSms(callerPhone, `MassMechanic: Reply with your ZIP + what’s going on, and we’ll connect you fast.`);
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

      if (!greeted) {
        greeted = true;
        await speakOverStream({
          ws,
          streamSid,
          text: VOICE_GREETING,
          deepgramKey: DEEPGRAM_API_KEY
        });
      }
      return;
    }

    if (data.event === "media" && deepgramLive?.readyState === WebSocket.OPEN) {
      deepgramLive.send(Buffer.from(data.media.payload, "base64"));
      return;
    }

    if (data.event === "stop") {
      try { if (deepgramLive) deepgramLive.close(); } catch {}
      return;
    }
  });

  ws.on("close", async () => {
    try { if (deepgramLive) deepgramLive.close(); } catch {}

    // Log every call on hangup (best-effort)
    await writeCallOutcome({
      callSid,
      callerPhone,
      confirmed: !!state.confirmed,
      outcome: state.confirmed ? "call_completed" : "caller_hung_up",
      name: state.name,
      zip: normalizeZip(state.zip),
      issueCategory: state.issueCategory,
      issueText: state.issueText,
      notes: "WS closed (hangup)"
    });
  });
});

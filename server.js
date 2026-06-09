// server.js
import express from "express";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";
import crypto from "crypto";

//────────────────────────────────────────────────────────────────────────────────
// 0) HELPERS
//────────────────────────────────────────────────────────────────────────────────

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
  return /^(yes|yeah|yep|yup|correct|right|that's right|thats right|affirmative|sure|ok|okay|mhm|uh huh)\b/i.test(text.trim());
}

function looksLikeNo(text = "") {
  return /^(no|nope|not really|nah|wrong|incorrect)\b/i.test(text.trim());
}

function normalizeNumberText(text = "") {
  return String(text)
    .replace(/\boh\b/gi, "0")
    .replace(/\bo\b/gi, "0");
}

function extractZip(text = "") {
  const normalized = normalizeNumberText(text);
  const m = normalized.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
}

function extractPhone(text = "") {
  const normalized = normalizeNumberText(text);
  const digits = normalized.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.substring(1);
  return "";
}

function extractName(text = "") {
  const original = String(text).trim();
  if (/(leak|leaking|pull|pulling|brake|braking|start|starting|overheat|check|engine|noise|rattle|clunk|grind|grinding|squeal|shake|vibration|smoke|stall|idle|rough|slip|slipping|shift|puddle|under)/i.test(original)) {
    return "";
  }
  const patterns = [
    /(?:my name is|my name's|this is|i'm|im|i am|it'?s|call me|they call me)\s+([a-z]{2,}(?:\s+[a-z]+)?)\b/i,
  ];
  for (const pattern of patterns) {
    const m = original.match(pattern);
    if (m?.[1]) {
      const extracted = m[1].trim();
      if (!/^(the|that|this|there|here|what|when|where|how|why|my|hi|hello|leak|leaking|pull|pulling)$/i.test(extracted)) {
        return extracted;
      }
    }
  }
  const cleaned = original.replace(/[^a-zA-Z\s]/g, "").trim();
  const words = cleaned.split(/\s+/).filter((w) => w.length >= 2);
  if (words.length === 1 && words[0].length >= 2 && words[0].length <= 15) {
    const word = words[0];
    if (!/^(the|that|this|there|here|what|when|where|how|why|yes|yeah|yep|nope|okay|sure|right|wrong|maybe|think|know|well|just|like|want|need|have|cant|don't|wont|hi|hello|hey|leak|leaking|pull|pulling|brake|start|engine|noise|grind|shake|smoke|code|zip)$/i.test(word)) {
      return word;
    }
  }
  if (words.length === 2 && words[0].length >= 2 && words[0].length <= 15) {
    const word = words[0];
    if (!/^(the|that|this|there|here|what|when|where|how|why|yes|yeah|yep|nope|okay|sure|right|wrong|maybe|think|know|well|just|like|want|need|have|cant|don't|wont|hi|hello|hey|leak|leaking|pull|pulling|brake|start|engine|noise|grind|shake|smoke|code|zip)$/i.test(word)) {
      return word;
    }
  }
  return "";
}

function extractCarYear(text = "") {
  const m = String(text).match(/\b(19\d{2}|20[0-2]\d)\b/);
  return m ? m[1] : "";
}

function extractCarMakeModel(text = "") {
  const cleaned = String(text).replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length < 6) return "";
  if (/(steering|wheel|pull|pulling|brake|start|overheat|check|engine|noise|rattle|clunk|grind|squeal|shake|vibration|leak|leaking|smoke|stall|idle|rough|slipping|shift|puddle)/i.test(cleaned)) return "";
  if (/^(hi|hello|hey|my|me|i|the|this|that|is|it|there)\b/i.test(cleaned)) return "";
  const m1 = cleaned.match(/\b(19\d{2}|20[0-2]\d)\s+([A-Za-z]+)\s+([A-Za-z0-9]+)\b/);
  if (m1) return `${m1[2]} ${m1[3]}`.trim();
  const carBrands = /\b(toyota|honda|ford|chevy|chevrolet|gmc|dodge|ram|jeep|nissan|mazda|subaru|hyundai|kia|volkswagen|vw|bmw|mercedes|audi|lexus|acura|infiniti|cadillac|buick|lincoln|volvo|tesla|porsche)\b/i;
  if (carBrands.test(cleaned)) {
    const m2 = cleaned.match(/\b([A-Za-z]+)\s+([A-Za-z0-9]+)\b/);
    if (m2) return `${m2[1]} ${m2[2]}`.trim();
  }
  return "";
}

function speakZipDigits(zip = "") {
  return String(zip).split("").map((d) => (d === "0" ? "zero" : d)).join(" ");
}

function speakPhoneDigits(phone = "") {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length !== 10) return phone;
  const part1 = digits.substring(0, 3).split("").map((d) => (d === "0" ? "zero" : d)).join(" ");
  const part2 = digits.substring(3, 6).split("").map((d) => (d === "0" ? "zero" : d)).join(" ");
  const part3 = digits.substring(6, 10).split("").map((d) => (d === "0" ? "zero" : d)).join(" ");
  return `${part1}, ${part2}, ${part3}`;
}

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
  if (/(leak|leaking|fluid|puddle|drip|dripping)/i.test(t)) return "leak";
  return "general";
}

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
    leak: "leak-diagnosis",
    general: "general-repair",
  };
  return map[cat] || "general-repair";
}

const FOLLOWUP_BY_CATEGORY = {
  brakes: "Got it. Are you hearing squeaking or grinding, and does it happen only when braking or all the time?",
  pulling_alignment: "Okay. Does it pull mostly at higher speeds, and does the steering wheel shake or feel off-center?",
  no_start: "I understand. When you turn the key, do you hear a click, a crank, or nothing at all? And are the dash lights on?",
  overheating: "Got it. Has the temp gauge gone into the red, or have you seen steam or coolant leaks? How long into driving does it happen?",
  check_engine: "Okay. Is the car running rough or losing power? And is the light flashing or solid?",
  transmission: "I see. Is it slipping, shifting hard, or refusing to go into gear? Any warning lights?",
  ac: "Understood. Is it blowing warm air constantly or only at idle? Any unusual noises when the AC is on?",
  electrical: "Got it. Are you seeing dimming lights, a battery warning, or intermittent power issues? When did it start?",
  tire: "Okay. Is the tire flat right now, or losing air slowly?",
  noise: "I hear you. Is it more like a clunk, knock, or rattle, and does it happen over bumps, turning, or accelerating?",
  leak: "Understood. What color is the fluid? And is it leaking while parked or only when running?",
  general: "Okay, tell me more about what's happening.",
};

//────────────────────────────────────────────────────────────────────────────────
// 1) CONFIGURATION & SETUP
//────────────────────────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));
app.use(express.urlencoded({ extended: true }));

const {
  ANTHROPIC_API_KEY,       // ← renamed from OPENAI / VITE_ANTHROPIC_API_KEY
  DEEPGRAM_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  SUPABASE_URL,
  SUPABASE_KEY,
  PUBLIC_BASE_URL,
  ADMIN_ESCALATION_PHONE,
  FACEBOOK_PAGE_ACCESS_TOKEN,
  FACEBOOK_VERIFY_TOKEN,
  FACEBOOK_APP_SECRET,
} = process.env;

if (!ANTHROPIC_API_KEY || !DEEPGRAM_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ CRITICAL: Missing required env vars.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

//────────────────────────────────────────────────────────────────────────────────
// 2) CLAUDE API HELPER
// Single wrapper for all Claude calls — keeps the rest of the code clean.
//────────────────────────────────────────────────────────────────────────────────

async function callClaude({ system, messages, maxTokens = 120, model = "claude-haiku-4-5-20251001" }) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const json = await response.json();
  return json?.content?.[0]?.text?.trim() ?? "";
}

//────────────────────────────────────────────────────────────────────────────────
// 3) HEALTH CHECK
//────────────────────────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.send("MassMechanic Server is Awake 🤖"));

//────────────────────────────────────────────────────────────────────────────────
// 4) TWILIO VOICE WEBHOOKS
//────────────────────────────────────────────────────────────────────────────────

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
  const OUTBOUND_CALLER_ID = "+15083009944";
  const ADMIN_DESTINATION = ADMIN_ESCALATION_PHONE || "+15088187698"; // fallback

  return res.send(`
<Response>
  <Say>Connecting you now.</Say>
  <Dial callerId="${OUTBOUND_CALLER_ID}" timeout="25" answerOnBridge="true">
    ${ADMIN_DESTINATION}
  </Dial>
  ...
`);
});

app.post("/hangup", (req, res) => {
  res.type("text/xml");
  return res.send(`<Response><Hangup/></Response>`);
});

// Updated greeting — mirrors the QuoteForm's first question
const VOICE_GREETING =
  "Thanks for calling Mass Mechanic. We connect you with trusted local mechanics for fast, free repair quotes. Quick question first — are you having car trouble right now and need immediate help, or are you calling to schedule something ahead of time?";

//────────────────────────────────────────────────────────────────────────────────
// 5) SPEAK + LOGGING HELPERS
//────────────────────────────────────────────────────────────────────────────────

function estimateSpeakMs(text = "") {
  return Math.max(1500, Math.min(10000, Math.ceil(String(text).length / 12) * 1000));
}

async function speakOverStream({ ws, streamSid, text, deepgramKey, retries = 2 }) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const ttsResponse = await fetch(
        "https://api.deepgram.com/v1/speak?model=aura-perseus-en&encoding=mulaw&sample_rate=8000&container=none",
        {
          method: "POST",
          headers: { Authorization: `Token ${deepgramKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        }
      );
      clearTimeout(timeout);
      if (!ttsResponse.ok) {
        const errText = await ttsResponse.text().catch(() => "");
        console.error(`❌ TTS Failed (attempt ${attempt + 1}/${retries + 1}):`, ttsResponse.status, errText);
        if (attempt < retries) { await new Promise((r) => setTimeout(r, 500)); continue; }
        return false;
      }
      const audioBuffer = await ttsResponse.arrayBuffer();
      const base64Audio = Buffer.from(audioBuffer).toString("base64");
      if (ws.readyState === WebSocket.OPEN && streamSid) {
        ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64Audio } }));
        return true;
      }
      return false;
    } catch (error) {
      console.error(`❌ TTS Error (attempt ${attempt + 1}/${retries + 1}):`, error.message);
      if (attempt < retries) { await new Promise((r) => setTimeout(r, 500)); continue; }
      return false;
    }
  }
  return false;
}

async function transferCallToHuman(callSid) {
  if (!ADMIN_ESCALATION_PHONE) return console.error("❌ Missing ADMIN_ESCALATION_PHONE");
  if (!callSid) return console.error("❌ Missing callSid — cannot transfer");
  const baseUrl = PUBLIC_BASE_URL || "https://mass-mechanic-bot.onrender.com";
  await twilioClient.calls(callSid).update({ url: `${baseUrl}/transfer`, method: "POST" });
  console.log("📞 Call transfer initiated", { callSid });
}

async function hangupCall(callSid) {
  if (!callSid) return console.error("❌ Missing callSid — cannot hangup");
  const baseUrl = PUBLIC_BASE_URL || "https://mass-mechanic-bot.onrender.com";
  try {
    await twilioClient.calls(callSid).update({ url: `${baseUrl}/hangup`, method: "POST" });
    console.log("📞 Call hangup initiated", { callSid });
  } catch (error) {
    console.error("❌ Hangup failed:", error);
  }
}

async function upsertCallOutcome({ callSid, patch }) {
  if (!callSid) return;
  try {
    const { data: existing } = await supabase
      .from("call_outcomes")
      .select("call_sid")
      .eq("call_sid", callSid)
      .maybeSingle();
    if (existing) {
      const { error } = await supabase.from("call_outcomes").update(patch).eq("call_sid", callSid);
      if (error) console.error("⚠️ call_outcomes update failed:", error.message);
    } else {
      const { error } = await supabase.from("call_outcomes").insert({ call_sid: callSid, ...patch });
      if (error) console.error("⚠️ call_outcomes insert failed:", error.message);
    }
  } catch (e) {
    console.error("⚠️ call_outcomes operation exception:", e);
  }
}

function isHighPriorityLead(urgency, drivable) {
  const isExtremelyUrgent = /(asap|right now|immediately|urgent|emergency|stranded|stuck|need help now|breaking down)/i.test(urgency || "");
  const notDrivable = /(no|not drivable|can't drive|cant drive|wont move|stuck|needs tow|need.*tow|stranded)/i.test(drivable || "");
  return isExtremelyUrgent || notDrivable;
}

async function createLeadFromCall({ callerPhone, state }) {
  try {
    // Build description with quote preference tag (mirrors QuoteForm behavior)
    const descriptionTag =
      state.quotePreference === "quotes"
        ? " [PREFERENCE: Get quotes from 2-3 mechanics]"
        : " [PREFERENCE: Connect with first available fast]";

    const payload = {
      service_type: serviceTypeFromCategory(state.issueCategory),
      zip_code: state.zip,
      car_make_model: state.carMakeModel || "Unknown",
      car_year: state.carYear || null,
      description: `${state.issueText || ""}${descriptionTag}`,
      name: state.name || null,
      phone: state.phone || callerPhone || null,
      email: "",
      lead_source: "voice",
      status: "new",
      lead_category: "repair",
      drivable: state.drivable || null,
      urgency_window: state.urgency_window || null,
      pickup_address: state.pickupAddress || null,   // ← NEW
      contact_preference: state.contactMethod || null, // ← NEW
    };

    const { data, error } = await supabase.from("leads").insert(payload).select("id, lead_code").maybeSingle();
    if (error) { console.error("❌ Lead insert failed:", error.message); return { ok: false, lead: null }; }
    if (!data) { console.error("❌ Lead insert returned no data"); return { ok: false, lead: null }; }

    console.log(`✅ Lead created: ${data.id} / ${data.lead_code}`);

    const priority = isHighPriorityLead(state.urgency_window, state.drivable);
    const dispatchUrl = priority
      ? `${SUPABASE_URL}/functions/v1/send-lead-to-mechanics`
      : `${SUPABASE_URL}/functions/v1/send-maintenance-lead-to-mechanics`;

    console.log(`📮 Dispatching ${priority ? "REPAIR" : "MAINTENANCE"} lead:`, data.id);

    const dispatchRes = await fetch(dispatchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ leadId: data.id }),
    });

    if (!dispatchRes.ok) {
      const errText = await dispatchRes.text().catch(() => "");
      console.error(`❌ Dispatch failed (${dispatchRes.status}):`, errText);
      return { ok: true, lead: data };
    }

    console.log("✅ Dispatch response:", await dispatchRes.json());
    return { ok: true, lead: data };
  } catch (err) {
    console.error("❌ createLeadFromCall exception:", err);
    return { ok: false, lead: null };
  }
}

//────────────────────────────────────────────────────────────────────────────────
// 6) MESSENGER CONVERSATION STATE
//────────────────────────────────────────────────────────────────────────────────

const messengerConversations = new Map();

function getMessengerState(senderId) {
  if (!messengerConversations.has(senderId)) {
    messengerConversations.set(senderId, { step: "initial", data: {}, lastActivity: Date.now() });
  }
  return messengerConversations.get(senderId);
}

function updateMessengerState(senderId, updates) {
  const state = getMessengerState(senderId);
  messengerConversations.set(senderId, { ...state, ...updates, lastActivity: Date.now() });
}

function clearMessengerState(senderId) {
  messengerConversations.delete(senderId);
}

setInterval(() => {
  const now = Date.now();
  const timeout = 30 * 60 * 1000;
  for (const [senderId, state] of messengerConversations.entries()) {
    if (now - state.lastActivity > timeout) messengerConversations.delete(senderId);
  }
}, 5 * 60 * 1000);

//────────────────────────────────────────────────────────────────────────────────
// 7) MESSENGER HELPER FUNCTIONS
//────────────────────────────────────────────────────────────────────────────────

function verifyRequestSignature(rawBody, signature) {
  if (!signature) return false;
  const elements = signature.split("=");
  const signatureHash = elements[1];
  const expectedHash = crypto.createHmac("sha256", FACEBOOK_APP_SECRET).update(rawBody).digest("hex");
  return signatureHash === expectedHash;
}

async function sendMessengerMessage(recipientId, message) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${FACEBOOK_PAGE_ACCESS_TOKEN}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, message }),
    });
    if (!response.ok) console.error("Messenger API Error:", await response.json());
  } catch (error) {
    console.error("Failed to send message:", error);
  }
}

async function sendQuickReplies(recipientId, text, replies) {
  await sendMessengerMessage(recipientId, {
    text,
    quick_replies: replies.map((reply) => ({
      content_type: "text",
      title: reply,
      payload: reply.toUpperCase(),
    })),
  });
}

async function getMessengerUserProfile(senderId) {
  try {
    const url = `https://graph.facebook.com/v18.0/${senderId}?fields=first_name,last_name&access_token=${FACEBOOK_PAGE_ACCESS_TOKEN}`;
    const response = await fetch(url);
    const data = await response.json();
    return { name: `${data.first_name} ${data.last_name}` };
  } catch (error) {
    console.error("Failed to get user profile:", error);
    return null;
  }
}

function extractPhoneNumberMessenger(text) {
  const cleaned = text.replace(/\D/g, "");
  if (cleaned.length === 10) return `+1${cleaned}`;
  if (cleaned.length === 11 && cleaned[0] === "1") return `+${cleaned}`;
  return null;
}

// ── Messenger issue analysis now uses Claude instead of GPT ──
async function analyzeMessengerIssue(text) {
  try {
    const raw = await callClaude({
      model: "claude-haiku-4-5-20251001",
      maxTokens: 100,
      system:
        'Extract car issue category from the user message. Categories: brakes, engine, no-start, overheating, transmission, electrical, other. ' +
        'Respond ONLY with valid JSON — no preamble, no markdown: {"hasIssue": boolean, "category": string}',
      messages: [{ role: "user", content: text }],
    });

    // Strip any accidental markdown fences before parsing
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (error) {
    console.error("Error analyzing issue with Claude:", error);
    // Regex fallback
    const lowerText = text.toLowerCase();
    let category = "other";
    if (lowerText.includes("brake")) category = "brakes";
    else if (lowerText.includes("engine") || lowerText.includes("start")) category = "engine";
    else if (lowerText.includes("transmission")) category = "transmission";
    else if (lowerText.includes("overheat") || lowerText.includes("temperature")) category = "overheating";
    else if (lowerText.includes("electrical") || lowerText.includes("battery")) category = "electrical";
    return { hasIssue: text.length > 10, category };
  }
}

//────────────────────────────────────────────────────────────────────────────────
// 8) MESSENGER CONVERSATION HANDLERS
//────────────────────────────────────────────────────────────────────────────────

async function handleInitialMessengerMessage(senderId, text, state) {
  const analysis = await analyzeMessengerIssue(text);
  if (analysis.hasIssue) {
    updateMessengerState(senderId, { step: "awaiting_location", data: { issue: text, category: analysis.category } });
    await sendQuickReplies(senderId, "Got it! Which area are you in?", ["Brockton", "Fall River", "New Bedford"]);
  } else {
    await sendMessengerMessage(senderId, { text: "Hi! I can help you get free quotes from local mechanics. What's going on with your car?" });
  }
}

async function handleLocationResponse(senderId, text, state) {
  const location = text.toLowerCase();
  let city;
  if (location.includes("brockton")) city = "Brockton";
  else if (location.includes("fall river")) city = "Fall River";
  else if (location.includes("new bedford")) city = "New Bedford";
  else {
    await sendQuickReplies(senderId, "I didn't catch that. Which area are you in?", ["Brockton", "Fall River", "New Bedford"]);
    return;
  }
  updateMessengerState(senderId, { step: "awaiting_phone", data: { ...state.data, location: city } });
  await sendMessengerMessage(senderId, { text: "Perfect! What's the best phone number to reach you? (Mechanics will text/call you with quotes)" });
}

async function handlePhoneResponse(senderId, text, state) {
  const phone = extractPhoneNumberMessenger(text);
  if (!phone) {
    await sendMessengerMessage(senderId, { text: "I need a valid phone number so mechanics can reach you. Please try again:" });
    return;
  }
  updateMessengerState(senderId, { step: "awaiting_confirmation", data: { ...state.data, phone } });
  await sendMessengerMessage(senderId, {
    text:
      `Great! Here's what I have:\n\n` +
      `🔧 Issue: ${state.data.issue}\n` +
      `📍 Area: ${state.data.location}\n` +
      `📱 Phone: ${phone}\n\n` +
      `Reply "YES" to submit, or "CHANGE" to start over.`,
  });
}

async function handleConfirmation(senderId, text, state) {
  const response = text.toLowerCase();
  if (response.includes("yes") || response.includes("confirm") || response.includes("correct")) {
    await createLeadFromMessenger(senderId, state.data);
    await sendMessengerMessage(senderId, {
      text: `✅ Got it! We're connecting you with local mechanics now. You'll receive quotes via text at ${state.data.phone} within the next hour.`,
    });
    clearMessengerState(senderId);
  } else if (response.includes("change") || response.includes("start over")) {
    clearMessengerState(senderId);
    await sendMessengerMessage(senderId, { text: "No problem! What's going on with your car?" });
  } else {
    await sendMessengerMessage(senderId, { text: 'Reply "YES" to submit your quote request, or "CHANGE" to start over.' });
  }
}

async function createLeadFromMessenger(senderId, data) {
  try {
    const userProfile = await getMessengerUserProfile(senderId);
    const { data: lead, error } = await supabase
      .from("leads")
      .insert({
        service_type: serviceTypeFromCategory(data.category),
        zip_code: extractZip(data.location) || null,
        car_make_model: "Unknown",
        description: data.issue,
        name: userProfile?.name || "Messenger User",
        phone: data.phone,
        email: "",
        lead_source: "messenger",
        status: "new",
        lead_category: "repair",
        facebook_psid: senderId,
      })
      .select("id, lead_code")
      .single();

    if (error) throw error;
    console.log(`✅ Messenger lead created: ${lead.id}`);

    await fetch(`${SUPABASE_URL}/functions/v1/send-lead-to-mechanics`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ leadId: lead.id }),
    });
  } catch (error) {
    console.error("Failed to create Messenger lead:", error);
    await sendMessengerMessage(senderId, {
      text: "Sorry, something went wrong. Please call us at 617-315-3444 or visit massmechanic.com",
    });
  }
}

async function handleMessengerMessage(senderId, message) {
  const text = message.text?.trim();
  if (!text) {
    await sendMessengerMessage(senderId, { text: "I see you sent a photo! To get the fastest quote, please describe what's wrong with your car." });
    return;
  }
  const state = getMessengerState(senderId);
  switch (state.step) {
    case "initial": await handleInitialMessengerMessage(senderId, text, state); break;
    case "awaiting_location": await handleLocationResponse(senderId, text, state); break;
    case "awaiting_phone": await handlePhoneResponse(senderId, text, state); break;
    case "awaiting_confirmation": await handleConfirmation(senderId, text, state); break;
    default: await handleInitialMessengerMessage(senderId, text, state);
  }
}

function handleMessengerPostback(senderId, postback) {
  console.log("Postback received:", postback);
}

//────────────────────────────────────────────────────────────────────────────────
// 9) MESSENGER WEBHOOK ENDPOINTS
//────────────────────────────────────────────────────────────────────────────────

app.get("/webhook/messenger", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === FACEBOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    res.status(200).send(challenge);
  } else {
    console.log("❌ Webhook verification failed");
    res.sendStatus(403);
  }
});

app.post("/webhook/messenger", (req, res) => {
  const body = req.body;
  const signature = req.headers["x-hub-signature-256"];
  if (!verifyRequestSignature(req.rawBody || JSON.stringify(body), signature)) {
    console.log("❌ Invalid signature");
    return res.sendStatus(403);
  }
  if (body.object === "page") {
    res.status(200).send("EVENT_RECEIVED");
    body.entry.forEach((entry) => {
      entry.messaging.forEach((webhookEvent) => {
        const senderId = webhookEvent.sender.id;
        if (webhookEvent.message) handleMessengerMessage(senderId, webhookEvent.message);
        else if (webhookEvent.postback) handleMessengerPostback(senderId, webhookEvent.postback);
      });
    });
  } else {
    res.sendStatus(404);
  }
});

//────────────────────────────────────────────────────────────────────────────────
// 10) WEBSOCKET SERVER (VOICE AGENT)
//────────────────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📞 Voice webhook: ${PUBLIC_BASE_URL || "http://localhost:" + PORT}/voice`);
  console.log(`💬 Messenger webhook: ${PUBLIC_BASE_URL || "http://localhost:" + PORT}/webhook/messenger`);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let streamSid = null;
  let callSid = null;
  let callerPhone = "unknown";
  let greeted = false;
  let processing = false;
  let isSpeaking = false;
  let speakUntilTs = 0;
  let lastBotQuestionAt = 0;
  let transferred = false;
  let pendingFinal = null;
  let deepgramLive = null;
  let deepgramKeepaliveInterval = null;
  let messages = []; // conversation history for Claude fallback

  // ── State object — updated to match current QuoteForm fields ──
  const state = {
    currentStep: "urgency_type",   // first question mirrors the form
    urgencyType: "",               // "emergency" | "scheduled"
    issueText: "",
    issueCategory: "general",
    askedFollowup: false,
    awaitingFollowupResponse: false,
    carYear: "",
    carMakeModel: "",
    name: "",
    zip: "",
    phone: "",
    urgency_window: "",
    quotePreference: "",           // "fast" | "quotes"   ← NEW (matches form)
    drivable: "",
    pickupAddress: "",             // ← NEW (when drivable = No)
    contactMethod: "",             // ← NEW (phone/text/email)
    confirmed: false,
    leadCreated: false,
    awaitingConfirmation: false,
    awaitingCorrectionChoice: false,
    correctingField: null,
  };

  function clearDeepgramKeepalive() {
    if (deepgramKeepaliveInterval) {
      clearInterval(deepgramKeepaliveInterval);
      deepgramKeepaliveInterval = null;
    }
  }

  function startDeepgramKeepalive() {
    clearDeepgramKeepalive();
    deepgramKeepaliveInterval = setInterval(() => {
      if (deepgramLive && deepgramLive.readyState === WebSocket.OPEN) {
        deepgramLive.send(JSON.stringify({ type: "KeepAlive" }));
        console.log("💓 Deepgram keepalive sent");
      } else {
        clearDeepgramKeepalive();
      }
    }, 8000);
  }

  // ── Deepgram connection ──
  try {
    const dgUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=en-US&smart_format=true&interim_results=true&utterance_end_ms=1500&endpointing=500`;
    deepgramLive = new WebSocket(dgUrl, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });

    deepgramLive.on("open", () => {
      console.log("🎙 Deepgram connected");
      startDeepgramKeepalive();
    });

    deepgramLive.on("error", (err) => {
      console.error("❌ Deepgram error:", err);
      clearDeepgramKeepalive();
    });

    deepgramLive.on("close", () => {
      console.log("🎙 Deepgram closed");
      clearDeepgramKeepalive();
    });

    deepgramLive.on("message", async (msg) => {
      try {
        const data = JSON.parse(msg);
        const transcript = data?.channel?.alternatives?.[0]?.transcript?.trim();
        const speechFinal = !!data?.speech_final;
        if (!transcript) return;

        const silentTooLong = Date.now() - lastBotQuestionAt > 30000;
        if (silentTooLong && !transferred && !state.confirmed) {
          transferred = true;
          await upsertCallOutcome({ callSid, patch: { caller_phone: callerPhone, name: state.name || null, zip_code: state.zip || null, issue_text: state.issueText || null, issue_category: state.issueCategory || null, confirmed: false, outcome: "silence_timeout", notes: "User silent for 30+ seconds", source: "voice" } });
          await say("I haven't heard from you in a bit. Let me connect you with someone who can help.");
          await transferCallToHuman(callSid);
          clearDeepgramKeepalive();
          try { if (deepgramLive) deepgramLive.close(); } catch {}
          try { ws.close(); } catch {}
          return;
        }

        if (speechFinal) {
          if (processing || (isSpeaking && Date.now() < speakUntilTs)) {
            pendingFinal = transcript;
          } else {
            pendingFinal = transcript;
            drainPendingFinal();
          }
        }
      } catch (e) {
        console.error("❌ Deepgram message parsing error:", e);
      }
    });
  } catch (e) {
    console.error("❌ Deepgram initialization error:", e);
  }

  function readyToConfirm() {
    return (
      state.issueText &&
      state.carMakeModel &&
      state.name &&
      state.zip &&
      state.phone &&
      state.urgency_window &&
      state.drivable &&
      // If not drivable, pickup address is also required
      (state.drivable.toLowerCase() !== "no" || state.pickupAddress)
    );
  }

  async function say(text) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !streamSid) return;
    console.log(`🤖 Bot: ${text}`);
    isSpeaking = true;
    const ms = estimateSpeakMs(text);
    speakUntilTs = Date.now() + ms;
    lastBotQuestionAt = Date.now();
    const ok = await speakOverStream({ ws, streamSid, text, deepgramKey: DEEPGRAM_API_KEY });
    if (!ok) { speakUntilTs = Date.now() + 500; console.error("❌ TTS completely failed after retries"); }
    setTimeout(() => { isSpeaking = false; }, ms + 500);
  }

  async function drainPendingFinal() {
    if (!pendingFinal) return;
    processing = true;

    try {
      const text = pendingFinal;
      pendingFinal = null;
      console.log(`🗣 User: ${text}`);

      // ── Human transfer request (always checked first) ──
      if (wantsHumanFromText(text)) {
        transferred = true;
        await upsertCallOutcome({ callSid, patch: { caller_phone: callerPhone, name: state.name || null, zip_code: state.zip || null, issue_text: state.issueText || null, issue_category: state.issueCategory || null, confirmed: false, outcome: "transfer_requested", notes: "User requested a human", source: "voice" } });
        await say("Got it — connecting you to an operator now.");
        await transferCallToHuman(callSid);
        clearDeepgramKeepalive();
        try { if (deepgramLive) deepgramLive.close(); } catch {}
        try { ws.close(); } catch {}
        return;
      }

      // ── STEP 0: Emergency vs Scheduled (mirrors QuoteForm first question) ──
      if (!state.urgencyType) {
        const isEmergency = /(right now|immediate|emergency|help now|stranded|broke down|won't start|wont start|can't drive|cant drive|stuck|urgent|asap|today|happening now)/i.test(text);
        const isScheduled = /(schedule|scheduled|ahead|plan|planning|later|next week|this week|appointment|not urgent|no rush|in a few)/i.test(text);

        if (isEmergency || looksLikeYes(text)) {
          state.urgencyType = "emergency";
          state.urgency_window = "Today";
          state.currentStep = "issue";
          await say("Got it — let's get you help fast. What's going on with your car?");
          return;
        } else if (isScheduled || looksLikeNo(text)) {
          state.urgencyType = "scheduled";
          state.currentStep = "issue";
          await say("No problem. Tell me what's going on with your car and we'll find you the best local mechanic.");
          return;
        } else {
          await say("Are you having an emergency right now and need immediate help, or are you calling to schedule ahead?");
          return;
        }
      }

      // ── Correction choice handler ──
      if (state.awaitingCorrectionChoice) {
        const lower = text.toLowerCase();
        if (/(zip|zip code|zipcode)/i.test(lower)) { state.correctingField = "zip"; state.zip = ""; state.currentStep = "zip"; state.awaitingCorrectionChoice = false; await say("Okay, what's your 5-digit ZIP code?"); return; }
        if (/(name|first name)/i.test(lower)) { state.correctingField = "name"; state.name = ""; state.currentStep = "name"; state.awaitingCorrectionChoice = false; await say("Okay, what's your first name?"); return; }
        if (/(car|vehicle|make|model)/i.test(lower)) { state.correctingField = "car"; state.carMakeModel = ""; state.carYear = ""; state.currentStep = "car"; state.awaitingCorrectionChoice = false; await say("Okay, what's the make and model of your car?"); return; }
        if (/(issue|problem|wrong)/i.test(lower)) { state.correctingField = "issue"; state.issueText = ""; state.currentStep = "issue"; state.awaitingCorrectionChoice = false; await say("Okay, tell me what's wrong with your car."); return; }
        if (/(phone|number|telephone)/i.test(lower)) { state.correctingField = "phone"; state.phone = ""; state.currentStep = "phone"; state.awaitingCorrectionChoice = false; await say("Okay, what's your 10-digit phone number? Say the digits slowly, three at a time."); return; }
        if (/(urgency|when|time)/i.test(lower)) { state.correctingField = "urgency"; state.urgency_window = ""; state.currentStep = "urgency"; state.awaitingCorrectionChoice = false; await say("Okay, when do you need the repair done?"); return; }
        if (/(drivable|drive|driving)/i.test(lower)) { state.correctingField = "drivable"; state.drivable = ""; state.currentStep = "drivable"; state.awaitingCorrectionChoice = false; await say("Okay, can you drive the car, or does it need to be towed?"); return; }
        if (/(address|pickup|location|where)/i.test(lower)) { state.correctingField = "pickup_address"; state.pickupAddress = ""; state.currentStep = "pickup_address"; state.awaitingCorrectionChoice = false; await say("Okay, what's the address where the car is located?"); return; }
        await say("Sorry, I didn't catch that. What would you like to correct?");
        return;
      }

      // ── Followup response ──
      if (state.awaitingFollowupResponse) {
        if (text.length > 3) {
          state.issueText = `${state.issueText}. ${text}`;
          state.awaitingFollowupResponse = false;
          state.currentStep = "car";
          console.log(`✅ Added followup details: ${text}`);
        }
      }

      // ── Field extraction ──
      if (state.currentStep === "zip" && !state.zip) {
        const z = extractZip(text);
        if (z) { state.zip = z; state.correctingField = null; console.log(`✅ Extracted ZIP: ${z}`); }
      }

      if (state.currentStep === "phone" && !state.phone) {
        const p = extractPhone(text);
        if (p) { state.phone = p; state.correctingField = null; console.log(`✅ Extracted phone: ${p}`); }
      }

      if (state.currentStep === "name" && !state.name) {
        const n = extractName(text);
        if (n) { state.name = n; state.correctingField = null; console.log(`✅ Extracted name: ${n}`); }
      }

      if (state.currentStep === "car") {
        if (!state.carYear) { const y = extractCarYear(text); if (y) { state.carYear = y; console.log(`✅ Extracted year: ${y}`); } }
        if (!state.carMakeModel) { const mm = extractCarMakeModel(text); if (mm) { state.carMakeModel = mm; state.correctingField = null; console.log(`✅ Extracted car: ${mm}`); } }
      }

      if (state.currentStep === "issue" && !state.issueText) {
        const z = extractZip(text);
        const n = extractName(text);
        if (!z && !n && text.length > 6) {
          state.issueText = text;
          state.issueCategory = categorizeIssue(text);
          state.correctingField = null;
          console.log(`✅ Captured issue: ${text} (category: ${state.issueCategory})`);
        }
      }

      if (state.currentStep === "urgency" && !state.urgency_window) {
        state.urgency_window = text;
        state.correctingField = null;
        console.log(`✅ Captured urgency: ${text}`);
      }

      if (state.currentStep === "drivable" && !state.drivable) {
        state.drivable = text;
        state.correctingField = null;
        console.log(`✅ Captured drivability: ${text}`);
      }

      // ── NEW: Pickup address (when not drivable) ──
      if (state.currentStep === "pickup_address" && !state.pickupAddress) {
        if (text.length > 5) {
          state.pickupAddress = text;
          state.correctingField = null;
          console.log(`✅ Captured pickup address: ${text}`);
        }
      }

      // ── NEW: Quote preference ──
      if (state.currentStep === "quote_preference" && !state.quotePreference) {
        const wantsFast = /(fast|first|available|quick|asap|now|immediately|connect|whoever)/i.test(text);
        const wantsQuotes = /(quote|quotes|compare|multiple|two|three|2|3|options|best price|shop around)/i.test(text);
        state.quotePreference = wantsQuotes ? "quotes" : "fast";
        state.correctingField = null;
        console.log(`✅ Quote preference: ${state.quotePreference}`);
      }

      // ── NEW: Contact method preference ──
      if (state.currentStep === "contact_method" && !state.contactMethod) {
        const wantsPhone = /(phone|call|calling)/i.test(text);
        const wantsEmail = /(email|mail)/i.test(text);
        state.contactMethod = wantsPhone ? "phone" : wantsEmail ? "email" : "text";
        state.correctingField = null;
        console.log(`✅ Contact method: ${state.contactMethod}`);
      }

      // ── Confirmation handler ──
      if (state.awaitingConfirmation && !state.confirmed) {
        if (looksLikeYes(text)) {
          state.confirmed = true;
          state.awaitingConfirmation = false;

          await upsertCallOutcome({ callSid, patch: { caller_phone: state.phone || callerPhone, name: state.name || null, zip_code: state.zip || null, issue_text: state.issueText || null, issue_category: state.issueCategory || null, confirmed: true, outcome: "confirmed", notes: "Confirmed details on call", source: "voice" } });

          if (!state.leadCreated) {
            const leadRes = await createLeadFromCall({ callerPhone, state });
            if (leadRes.ok) { state.leadCreated = true; console.log("✅ Lead created from voice:", leadRes.lead); }
          }

          const zipSpoken = speakZipDigits(state.zip);
          await say(`Perfect — thanks, ${state.name}. We'll connect you with a trusted local mechanic near ZIP ${zipSpoken}. A mechanic will contact you shortly. Thanks for calling Mass Mechanic. Goodbye!`);

          setTimeout(async () => {
            await hangupCall(callSid);
            clearDeepgramKeepalive();
            try { if (deepgramLive) deepgramLive.close(); } catch {}
            try { ws.close(); } catch {}
          }, 4000);
          return;
        }

        if (looksLikeNo(text)) {
          state.awaitingConfirmation = false;
          state.awaitingCorrectionChoice = true;
          await say("No problem — what should I correct? You can say zip, name, car, issue, phone, urgency, drivable, or address.");
          return;
        }

        await say("Sorry, I didn't catch that. Is that information correct?");
        return;
      }

      // ──────────────────────────────────────────────────────────────────────
      // CONVERSATION FLOW — mirrors QuoteForm field order
      // ──────────────────────────────────────────────────────────────────────

      if (!state.issueText) {
        state.currentStep = "issue";
        await say("Tell me what's going on with your car.");
        return;
      }

      if (state.issueText && !state.askedFollowup) {
        state.askedFollowup = true;
        state.awaitingFollowupResponse = true;
        state.currentStep = "followup";
        const followup = FOLLOWUP_BY_CATEGORY[state.issueCategory] || FOLLOWUP_BY_CATEGORY.general;
        await say(followup);
        return;
      }

      if (!state.carMakeModel) {
        state.currentStep = "car";
        await say("What's the make and model of your car?");
        return;
      }

      if (!state.name) {
        state.currentStep = "name";
        await say("And what's your first name?");
        return;
      }

      if (!state.zip) {
        state.currentStep = "zip";
        await say("What's your 5-digit ZIP code?");
        return;
      }

      if (!state.phone) {
        state.currentStep = "phone";
        await say("What's your 10-digit phone number? Say the digits slowly, three at a time.");
        return;
      }

      // Only ask urgency if this is a scheduled call (emergency already set it to "Today")
      if (!state.urgency_window) {
        state.currentStep = "urgency";
        await say("When do you need the repair done — today, within a few days, or next week?");
        return;
      }

      // NEW: Quote preference (mirrors form toggle)
      if (!state.quotePreference) {
        state.currentStep = "quote_preference";
        await say("Would you prefer we connect you with the first available mechanic as fast as possible, or would you like quotes from two or three mechanics to compare prices?");
        return;
      }

      if (!state.drivable) {
        state.currentStep = "drivable";
        await say("Can you drive the car to a shop, or does it need to be towed?");
        return;
      }

      // NEW: Pickup address when not drivable (mirrors form behavior)
      if (/(no|not drivable|can't drive|cant drive|needs tow|need tow|stranded|stuck)/i.test(state.drivable) && !state.pickupAddress) {
        state.currentStep = "pickup_address";
        await say("Since the car can't be driven, what's the street address or cross streets where it's located right now?");
        return;
      }

      // NEW: Contact method preference
      if (!state.contactMethod) {
        state.currentStep = "contact_method";
        await say("Last thing — would you prefer the mechanic contact you by phone call, text, or email?");
        return;
      }

      // ── Ready to confirm ──
      if (readyToConfirm() && !state.confirmed && !state.awaitingConfirmation) {
        state.awaitingConfirmation = true;
        state.currentStep = "confirm";
        const zipSpoken = speakZipDigits(state.zip);
        const phoneSpoken = speakPhoneDigits(state.phone);
        const carSpoken = `${state.carYear ? state.carYear + " " : ""}${state.carMakeModel}`.trim();
        const pickupNote = state.pickupAddress ? ` The car is at ${state.pickupAddress}.` : "";
        await say(
          `To confirm: you're ${state.name} in ZIP ${zipSpoken}, phone ${phoneSpoken}, the car is a ${carSpoken}, and the issue is "${state.issueText}".${pickupNote} Is that right?`
        );
        return;
      }

      // ── Claude fallback for anything unhandled ──
      messages.push({ role: "user", content: text });

      const aiText = await callClaude({
        model: "claude-haiku-4-5-20251001",
        maxTokens: 90,
        system:
          `You are a voice assistant for MassMechanic collecting car repair lead info over the phone. Keep responses under 20 words. Be conversational and friendly. ` +
          `Current state — name: "${state.name}", zip: "${state.zip}", phone: "${state.phone}", car: "${state.carYear} ${state.carMakeModel}", ` +
          `issue: "${state.issueText}", urgency: "${state.urgency_window}", drivable: "${state.drivable}", ` +
          `quotePreference: "${state.quotePreference}", contactMethod: "${state.contactMethod}". ` +
          `Ask ONE short question to collect the next missing piece of information. Do not ask for last name.`,
        messages,
      }).catch((err) => {
        console.error("❌ Claude fallback error:", err);
        return "";
      });

      if (!aiText) {
        await say("I'm having a quick technical issue. Please text us your ZIP and what's going on, and we'll follow up right away.");
        return;
      }

      messages.push({ role: "assistant", content: aiText });
      await say(aiText);

    } catch (e) {
      console.error("❌ Processing Error:", e);
      try { await say("Sorry — I had a quick technical glitch. Please text us your ZIP and car issue, and we'll follow up right away."); } catch {}
    } finally {
      processing = false;
      if (pendingFinal && !transferred) {
        setTimeout(() => {
          if (!processing && !(isSpeaking && Date.now() < speakUntilTs)) drainPendingFinal();
        }, 400);
      }
    }
  }

  // ── WebSocket event handlers ──
  ws.on("message", async (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      const params = data.start?.customParameters || {};
      const pFrom = normalizePhone(params.from || "");
      const pCaller = normalizePhone(params.caller || "");
      callerPhone = pFrom || pCaller || "unknown";
      callSid = params.callSid || data.start.callSid || callSid;
      console.log("☎️ Stream start", { streamSid, callSid, callerPhone });
      await upsertCallOutcome({ callSid, patch: { caller_phone: callerPhone, source: "voice", outcome: "in_progress", confirmed: false, notes: null } });
      if (!greeted) { greeted = true; await say(VOICE_GREETING); }
      return;
    }

    if (data.event === "media" && deepgramLive?.readyState === WebSocket.OPEN) {
      deepgramLive.send(Buffer.from(data.media.payload, "base64"));
      return;
    }

    if (data.event === "stop") {
      await upsertCallOutcome({ callSid, patch: { caller_phone: state.phone || callerPhone, name: state.name || null, zip_code: state.zip || null, issue_text: state.issueText || null, issue_category: state.issueCategory || null, confirmed: !!state.confirmed, outcome: state.confirmed ? "completed" : transferred ? "transferred" : "ended_unconfirmed", notes: state.confirmed ? "Call completed after confirmation" : "Call ended before confirmation", source: "voice" } });
      clearDeepgramKeepalive();
      try { if (deepgramLive) deepgramLive.close(); } catch {}
      return;
    }
  });

  ws.on("close", async () => {
    clearDeepgramKeepalive();
    try { if (deepgramLive) deepgramLive.close(); } catch {}
    await upsertCallOutcome({ callSid, patch: { caller_phone: state.phone || callerPhone, name: state.name || null, zip_code: state.zip || null, issue_text: state.issueText || null, issue_category: state.issueCategory || null, confirmed: !!state.confirmed, outcome: state.confirmed ? "completed" : transferred ? "transferred" : "socket_closed", notes: state.confirmed ? "Socket closed after confirmation" : "Socket closed before confirmation", source: "voice" } });
  });
});

// server.js
import express from "express";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

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

function extractZip(text = "") {
  const m = String(text).match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
}

// NEW: Extract phone number (10 digits)
function extractPhone(text = "") {
  // Remove all non-digits
  const digits = String(text).replace(/\D/g, "");
  
  // Look for 10-digit or 11-digit (with 1 prefix) phone numbers
  if (digits.length === 10) {
    return digits;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.substring(1); // Remove leading 1
  }
  
  return "";
}

function extractName(text = "") {
  const original = String(text).trim();
  
  // CRITICAL: Don't extract if text contains car problem keywords
  if (/(leak|leaking|pull|pulling|brake|braking|start|starting|overheat|check|engine|noise|rattle|clunk|grind|grinding|squeal|shake|vibration|smoke|stall|idle|rough|slip|slipping|shift|puddle|under)/i.test(original)) {
    return "";
  }
  
  // Pattern 1: "My name is ___", "This is ___", "I'm ___", "It's ___", "Call me ___"
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
  
  // Pattern 2: Just a name by itself (very conservative)
  const cleaned = original.replace(/[^a-zA-Z\s]/g, '').trim();
  const words = cleaned.split(/\s+/).filter(w => w.length >= 2);
  
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
  const cleaned = String(text)
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  
  if (cleaned.length < 6) return "";
  
  if (/(steering|wheel|pull|pulling|brake|start|overheat|check|engine|noise|rattle|clunk|grind|squeal|shake|vibration|leak|leaking|smoke|stall|idle|rough|slipping|shift|puddle)/i.test(cleaned)) {
    return "";
  }
  
  if (/^(hi|hello|hey|my|me|i|the|this|that|is|it|there)\b/i.test(cleaned)) {
    return "";
  }
    
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
  return String(zip)
    .split("")
    .map((d) => (d === "0" ? "zero" : d))
    .join(" ");
}

// NEW: Speak phone number in groups of 3-3-4
function speakPhoneDigits(phone = "") {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length !== 10) return phone;
  
  // Format: (123) 456-7890 -> "1 2 3, 4 5 6, 7 8 9 0"
  const part1 = digits.substring(0, 3).split("").join(" ");
  const part2 = digits.substring(3, 6).split("").join(" ");
  const part3 = digits.substring(6, 10).split("").join(" ");
  
  return `${part1}, ${part2}, ${part3}`;
}

// Issue routing (keyword-based)
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

// Map voice category -> leads.service_type
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

//────────────────────────────────────────────────────────────────────────────────
// 2) HEALTH CHECK
//────────────────────────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.send("MassMechanic Server is Awake 🤖"));

//────────────────────────────────────────────────────────────────────────────────
// 3) TWILIO VOICE WEBHOOKS
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

app.post("/hangup", (req, res) => {
  res.type("text/xml");
  res.send(`
<Response>
  <Hangup/>
</Response>
  `);
});

const VOICE_GREETING = "Thanks for calling Mass Mechanic — we connect you with trusted local mechanics for fast, free repair quotes. Tell me what's wrong with your car or ask me a quick question.";

//────────────────────────────────────────────────────────────────────────────────
// 4) SPEAK + LOGGING HELPERS
//────────────────────────────────────────────────────────────────────────────────

function estimateSpeakMs(text = "") {
  const ms = Math.max(1500, Math.min(10000, Math.ceil(String(text).length / 12) * 1000));
  return ms;
}

async function speakOverStream({ ws, streamSid, text, deepgramKey, retries = 2 }) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      const ttsResponse = await fetch(
        "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mulaw&sample_rate=8000&container=none",
        {
          method: "POST",
          headers: {
            Authorization: `Token ${deepgramKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        }
      );
      
      clearTimeout(timeout);
      
      if (!ttsResponse.ok) {
        const errText = await ttsResponse.text().catch(() => "");
        console.error(`❌ TTS Failed (attempt ${attempt + 1}/${retries + 1}):`, ttsResponse.status, errText);
        
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
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
      
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      return false;
    }
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

async function hangupCall(callSid) {
  if (!callSid) return console.error("❌ Missing callSid — cannot hangup");
  
  const baseUrl = PUBLIC_BASE_URL || "https://mass-mechanic-bot.onrender.com";
  const hangupUrl = `${baseUrl}/hangup`;
  
  try {
    await twilioClient.calls(callSid).update({ url: hangupUrl, method: "POST" });
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
      const { error } = await supabase
        .from("call_outcomes")
        .update(patch)
        .eq("call_sid", callSid);
      if (error) console.error("⚠️ call_outcomes update failed:", error.message);
    } else {
      const { error } = await supabase
        .from("call_outcomes")
        .insert({ call_sid: callSid, ...patch });
      if (error) console.error("⚠️ call_outcomes insert failed:", error.message);
    }
  } catch (e) {
    console.error("⚠️ call_outcomes operation exception:", e);
  }
}

// NEW: Determine if lead is high-priority based on urgency and drivability
function isHighPriorityLead(urgency, drivable) {
  // High priority if:
  // 1. Urgent (today/ASAP) OR
  // 2. Not drivable
  const isUrgent = /today|asap|now|immediately|urgent|soon|right away/i.test(urgency || "");
  const notDrivable = /no|not drivable|can't drive|cant drive|wont move|stuck/i.test(drivable || "");
  
  return isUrgent || notDrivable;
}

async function createLeadFromCall({ callerPhone, state }) {
  try {
    const payload = {
      service_type: serviceTypeFromCategory(state.issueCategory),
      zip_code: state.zip,
      car_make_model: state.carMakeModel || "Unknown",
      car_year: state.carYear || null,
      description: state.issueText || "",
      name: state.name || null,
      phone: state.phone || callerPhone || null, // Use explicit phone first, fallback to caller ID
      email: "",
      lead_source: "voice",
      status: "new",
      lead_category: "repair",
      drivable: state.drivable || null,
      urgency_window: state.urgency_window || null,
    };
    
    const { data, error } = await supabase.from("leads").insert(payload).select("id, lead_code").maybeSingle();
    
    if (error) {
      console.error("❌ Lead insert failed:", error.message);
      return { ok: false, error: error.message };
    }
    
    console.log("✅ Lead created:", data);
    
    // NEW: Call appropriate edge function based on urgency/drivability
    const isHighPriority = isHighPriorityLead(state.urgency_window, state.drivable);
    
    if (isHighPriority) {
      console.log("📤 Dispatching HIGH PRIORITY lead to mechanics via send-lead");
      // Call your send-lead edge function
      // await fetch(`${SUPABASE_URL}/functions/v1/send-lead`, { ... });
    } else {
      console.log("📤 Dispatching maintenance lead to mechanics via send-maintenance-lead");
      // Call your send-maintenance-lead edge function
      // await fetch(`${SUPABASE_URL}/functions/v1/send-maintenance-lead`, { ... });
    }
    
    return { ok: true, lead: data };
  } catch (e) {
    console.error("❌ Lead insert exception:", e);
    return { ok: false, error: e?.message || "unknown" };
  }
}

//────────────────────────────────────────────────────────────────────────────────
// 5) WEBSOCKET SERVER FOR TWILIO MEDIA STREAMS
//────────────────────────────────────────────────────────────────────────────────

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
  
  let isSpeaking = false;
  let speakUntilTs = 0;
  let processing = false;
  let pendingFinal = null;
  let lastFinalAt = 0;
  let lastBotQuestionAt = 0;
  
  const state = {
    name: "",
    zip: "",
    phone: "", // NEW: Explicit phone number
    issueText: "",
    issueCategory: "general",
    askedFollowup: false,
    awaitingFollowupResponse: false,
    awaitingConfirmation: false,
    awaitingCorrectionChoice: false,
    correctingField: null,
    confirmed: false,
    carMakeModel: "",
    carYear: "",
    drivable: "", // NEW: Is the car drivable?
    urgency_window: "", // NEW: When do they need service?
    leadCreated: false,
    currentStep: "issue", // issue, followup, car, name, zip, phone, urgency, drivable, confirm
  };
  
  const messages = [
    {
      role: "system",
      content:
        "You are the MassMechanic phone agent. Keep replies SHORT (1 sentence). Ask ONE question at a time. " +
        "Goal: collect (1) what's wrong, (2) car make/model/year, (3) first name, (4) ZIP code, (5) phone number, (6) urgency, (7) drivability. " +
        "Do NOT ask for last name. Do NOT end the call until you confirm the details.",
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
      
      if (!received.is_final) return;
      
      const text = transcript.trim();
      if (!text) return;
      
      const now = Date.now();
      lastFinalAt = now;
      pendingFinal = text;
      
      if (processing) return;
      if (isSpeaking && now < speakUntilTs) return;
      
      const timeSinceBotQuestion = now - lastBotQuestionAt;
      if (timeSinceBotQuestion < 800) {
        setTimeout(() => {
          if (!processing && !transferred && pendingFinal) {
            drainPendingFinal();
          }
        }, 800 - timeSinceBotQuestion);
        return;
      }
      
      await drainPendingFinal();
    });
    
    deepgramLive.on("error", (err) => console.error("DG Error:", err));
  };
  
  setupDeepgram();
  
  function readyToConfirm() {
    return Boolean(
      state.issueText && 
      state.carMakeModel && 
      state.name && 
      state.zip && 
      state.phone && 
      state.urgency_window && 
      state.drivable
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
    
    if (!ok) {
      speakUntilTs = Date.now() + 500;
      console.error("❌ TTS completely failed after retries");
    }
    
    setTimeout(() => {
      isSpeaking = false;
    }, ms + 500);
  }
  
  async function drainPendingFinal() {
    if (!pendingFinal) return;
    processing = true;
    
    try {
      const text = pendingFinal;
      pendingFinal = null;
      
      console.log(`🗣 User: ${text}`);
      
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
        try { if (deepgramLive) deepgramLive.close(); } catch {}
        try { ws.close(); } catch {}
        return;
      }
      
      // Handle correction choice
      if (state.awaitingCorrectionChoice) {
        const lower = text.toLowerCase();
        
        if (/(zip|zip code|zipcode)/i.test(lower)) {
          state.correctingField = "zip";
          state.zip = "";
          state.currentStep = "zip";
          state.awaitingCorrectionChoice = false;
          await say("Okay, what's your 5-digit ZIP code?");
          return;
        }
        
        if (/(name|first name)/i.test(lower)) {
          state.correctingField = "name";
          state.name = "";
          state.currentStep = "name";
          state.awaitingCorrectionChoice = false;
          await say("Okay, what's your first name?");
          return;
        }
        
        if (/(car|vehicle|make|model)/i.test(lower)) {
          state.correctingField = "car";
          state.carMakeModel = "";
          state.carYear = "";
          state.currentStep = "car";
          state.awaitingCorrectionChoice = false;
          await say("Okay, what's the make and model of your car?");
          return;
        }
        
        if (/(issue|problem|wrong)/i.test(lower)) {
          state.correctingField = "issue";
          state.issueText = "";
          state.currentStep = "issue";
          state.awaitingCorrectionChoice = false;
          await say("Okay, tell me what's wrong with your car.");
          return;
        }
        
        // NEW: Allow correcting phone, urgency, drivability
        if (/(phone|number|telephone)/i.test(lower)) {
          state.correctingField = "phone";
          state.phone = "";
          state.currentStep = "phone";
          state.awaitingCorrectionChoice = false;
          await say("Okay, what's your 10-digit phone number? Say the digits slowly, three at a time.");
          return;
        }
        
        if (/(urgency|when|time)/i.test(lower)) {
          state.correctingField = "urgency";
          state.urgency_window = "";
          state.currentStep = "urgency";
          state.awaitingCorrectionChoice = false;
          await say("Okay, when do you need the repair done?");
          return;
        }
        
        if (/(drivable|drive|driving)/i.test(lower)) {
          state.correctingField = "drivable";
          state.drivable = "";
          state.currentStep = "drivable";
          state.awaitingCorrectionChoice = false;
          await say("Okay, can you drive the car, or does it need to be towed?");
          return;
        }
        
        await say("Sorry, I didn't catch that. What would you like to correct?");
        return;
      }
      
      // If awaiting followup response
      if (state.awaitingFollowupResponse) {
        if (text.length > 3) {
          state.issueText = `${state.issueText}. ${text}`;
          state.awaitingFollowupResponse = false;
          state.currentStep = "car";
          console.log(`✅ Added followup details: ${text}`);
        }
      }
      
      // Extract based on current step
      
      if (state.currentStep === "zip" && !state.zip) {
        const z = extractZip(text);
        if (z) {
          state.zip = z;
          state.correctingField = null;
          console.log(`✅ Extracted ZIP: ${z}`);
        }
      }
      
      if (state.currentStep === "phone" && !state.phone) {
        const p = extractPhone(text);
        if (p) {
          state.phone = p;
          state.correctingField = null;
          console.log(`✅ Extracted phone: ${p}`);
        }
      }
      
      if (state.currentStep === "name" && !state.name) {
        const n = extractName(text);
        if (n) {
          state.name = n;
          state.correctingField = null;
          console.log(`✅ Extracted name: ${n}`);
        }
      }
      
      if (state.currentStep === "car") {
        if (!state.carYear) {
          const y = extractCarYear(text);
          if (y) {
            state.carYear = y;
            console.log(`✅ Extracted year: ${y}`);
          }
        }
        
        if (!state.carMakeModel) {
          const mm = extractCarMakeModel(text);
          if (mm) {
            state.carMakeModel = mm;
            state.correctingField = null;
            console.log(`✅ Extracted car: ${mm}`);
          }
        }
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
      
      // NEW: Capture urgency and drivability
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
      
      // Confirmation handling
      if (state.awaitingConfirmation && !state.confirmed) {
        if (looksLikeYes(text)) {
          state.confirmed = true;
          state.awaitingConfirmation = false;
          
          await upsertCallOutcome({
            callSid,
            patch: {
              caller_phone: state.phone || callerPhone,
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
          
          if (!state.leadCreated) {
            const leadRes = await createLeadFromCall({ callerPhone, state });
            if (leadRes.ok) {
              state.leadCreated = true;
              console.log("✅ Lead created from voice:", leadRes.lead);
            }
          }
          
          await say(
            `Perfect — thanks, ${state.name}. We'll connect you with a trusted local mechanic near ZIP ${speakZipDigits(state.zip)}.`
          );
          
          setTimeout(async () => {
            console.log("📞 Initiating call hangup after confirmation");
            await hangupCall(callSid);
            try { if (deepgramLive) deepgramLive.close(); } catch {}
            try { ws.close(); } catch {}
          }, 2000);
          
          return;
        }
        
        if (looksLikeNo(text)) {
          state.awaitingConfirmation = false;
          state.awaitingCorrectionChoice = true;
          await say("No problem — what should I correct?");
          return;
        }
        
        await say("Sorry, I didn't catch that. Is that information correct?");
        return;
      }
      
      // UPDATED FLOW: issue -> followup -> car -> name -> zip -> phone -> urgency -> drivable -> confirm
      
      if (!state.issueText) {
        state.currentStep = "issue";
        await say("Tell me what's wrong with your car.");
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
      
      // NEW: Ask for phone number explicitly
      if (!state.phone) {
        state.currentStep = "phone";
        await say("And what's your 10-digit phone number? Say the digits slowly, three at a time.");
        return;
      }
      
      // NEW: Ask about urgency
      if (!state.urgency_window) {
        state.currentStep = "urgency";
        await say("When do you need the repair done — today, within a few days, or next week?");
        return;
      }
      
      // NEW: Ask if car is drivable
      if (!state.drivable) {
        state.currentStep = "drivable";
        await say("Can you drive the car to a shop, or does it need to be towed?");
        return;
      }
      
      // Confirmation
      if (readyToConfirm() && !state.confirmed && !state.awaitingConfirmation) {
        state.awaitingConfirmation = true;
        state.currentStep = "confirm";
        const zipSpoken = speakZipDigits(state.zip);
        const phoneSpoken = speakPhoneDigits(state.phone);
        const carSpoken = `${state.carYear ? state.carYear + " " : ""}${state.carMakeModel}`.trim();
        await say(
          `To confirm: you're ${state.name} in ZIP ${zipSpoken}, phone ${phoneSpoken}, the car is a ${carSpoken}, and the issue is "${state.issueText}". Is that right?`
        );
        return;
      }
      
      // Backup GPT
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
                `State: name="${state.name}", zip="${state.zip}", phone="${state.phone}", car="${state.carYear} ${state.carMakeModel}", ` +
                `issue="${state.issueText}", urgency="${state.urgency_window}", drivable="${state.drivable}". ` +
                `Ask ONE short question that collects missing info or confirms details. Do not ask last name.`,
            },
          ],
          max_tokens: 90,
        }),
      });
      
      const gptJson = await gpt.json();
      const aiText = gptJson?.choices?.[0]?.message?.content?.trim();
      
      if (!aiText) {
        await say("I'm having a quick technical issue. Please text us your ZIP and what's going on, and we'll follow up right away.");
        return;
      }
      
      messages.push({ role: "assistant", content: aiText });
      await say(aiText);
      
    } catch (e) {
      console.error("❌ Processing Error:", e);
      try {
        await say("Sorry — I had a quick technical glitch. Please text us your ZIP and car issue, and we'll follow up right away.");
      } catch {}
    } finally {
      processing = false;
      
      if (pendingFinal && !transferred) {
        setTimeout(() => {
          if (!processing && !(isSpeaking && Date.now() < speakUntilTs)) {
            drainPendingFinal();
          }
        }, 400);
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
      await upsertCallOutcome({
        callSid,
        patch: {
          caller_phone: state.phone || callerPhone,
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
      
      try { if (deepgramLive) deepgramLive.close(); } catch {}
      return;
    }
  });
  
  ws.on("close", async () => {
    try { if (deepgramLive) deepgramLive.close(); } catch {}
    
    await upsertCallOutcome({
      callSid,
      patch: {
        caller_phone: state.phone || callerPhone,
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


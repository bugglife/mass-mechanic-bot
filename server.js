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

function extractName(text = "") {
  const original = String(text).trim();
  
  // CRITICAL: Don't extract if text contains car problem keywords
  // This prevents extracting "leaking", "pulling", "grinding" etc as names
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
      // Make sure it's not a common false positive
      if (!/^(the|that|this|there|here|what|when|where|how|why|my|hi|hello|leak|leaking|pull|pulling)$/i.test(extracted)) {
        return extracted;
      }
    }
  }
  
  // Pattern 2: Just a name by itself (very conservative now)
  // Remove all non-letter characters except spaces
  const cleaned = original.replace(/[^a-zA-Z\s]/g, '').trim();
  const words = cleaned.split(/\s+/).filter(w => w.length >= 2);
  
  // Single word that looks like a name (2-15 chars, more strict)
  if (words.length === 1 && words[0].length >= 2 && words[0].length <= 15) {
    const word = words[0];
    // Much longer exclusion list
    if (!/^(the|that|this|there|here|what|when|where|how|why|yes|yeah|yep|nope|okay|sure|right|wrong|maybe|think|know|well|just|like|want|need|have|cant|don't|wont|hi|hello|hey|leak|leaking|pull|pulling|brake|start|engine|noise|grind|shake|smoke|code|zip)$/i.test(word)) {
      return word;
    }
  }
  
  // Two words - take the first (likely first name) - but be very strict
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
  
  // Don't extract if text is too short or contains problem keywords
  if (cleaned.length < 6) return "";
  
  // Exclude if it contains car problem keywords (these are issue descriptions, not car models)
  if (/(steering|wheel|pull|pulling|brake|start|overheat|check|engine|noise|rattle|clunk|grind|squeal|shake|vibration|leak|leaking|smoke|stall|idle|rough|slipping|shift|puddle)/i.test(cleaned)) {
    return "";
  }
  
  // Exclude greetings and common phrases
  if (/^(hi|hello|hey|my|me|i|the|this|that|is|it|there)\b/i.test(cleaned)) {
    return "";
  }
    
  // "1992 Ford Explorer" -> "Ford Explorer"
  const m1 = cleaned.match(/\b(19\d{2}|20[0-2]\d)\s+([A-Za-z]+)\s+([A-Za-z0-9]+)\b/);
  if (m1) return `${m1[2]} ${m1[3]}`.trim();
  
  // "Ford Explorer" - but must look like a car brand
  // Common car brands to look for
  const carBrands = /\b(toyota|honda|ford|chevy|chevrolet|gmc|dodge|ram|jeep|nissan|mazda|subaru|hyundai|kia|volkswagen|vw|bmw|mercedes|audi|lexus|acura|infiniti|cadillac|buick|lincoln|volvo|tesla|porsche)\b/i;
  
  if (carBrands.test(cleaned)) {
    const m2 = cleaned.match(/\b([A-Za-z]+)\s+([A-Za-z0-9]+)\b/);
    if (m2) return `${m2[1]} ${m2[2]}`.trim();
  }
  
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
  if (/(leak|leaking|fluid|puddle|drip|dripping)/i.test(t)) return "leak";
  
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

// Updated greeting as requested
const VOICE_GREETING = "Thanks for calling Mass Mechanic — we connect you with trusted local mechanics for fast, free repair quotes. Tell me what's wrong with your car or ask me a quick question.";

//────────────────────────────────────────────────────────────────────────────────
// 4) SPEAK + LOGGING HELPERS
//────────────────────────────────────────────────────────────────────────────────

function estimateSpeakMs(text = "") {
  // More conservative timing to avoid cutting off users
  // ~12 chars/sec (slower) + longer minimum
  const ms = Math.max(1500, Math.min(10000, Math.ceil(String(text).length / 12) * 1000));
  return ms;
}

// Enhanced with retry logic and better error handling
async function speakOverStream({ ws, streamSid, text, deepgramKey, retries = 2 }) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
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
          await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms before retry
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
        await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms before retry
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

// call_outcomes: create/update row - FIXED to handle missing UNIQUE constraint
async function upsertCallOutcome({ callSid, patch }) {
  if (!callSid) return;
  try {
    // First, try to find existing row
    const { data: existing } = await supabase
      .from("call_outcomes")
      .select("call_sid")
      .eq("call_sid", callSid)
      .maybeSingle();
    
    if (existing) {
      // Update existing
      const { error } = await supabase
        .from("call_outcomes")
        .update(patch)
        .eq("call_sid", callSid);
      if (error) console.error("⚠️ call_outcomes update failed:", error.message);
    } else {
      // Insert new
      const { error } = await supabase
        .from("call_outcomes")
        .insert({ call_sid: callSid, ...patch });
      if (error) console.error("⚠️ call_outcomes insert failed:", error.message);
    }
  } catch (e) {
    console.error("⚠️ call_outcomes operation exception:", e);
  }
}

// Create a lead in Supabase after confirmation - FIXED email field requirement
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
      email: null, // Voice calls don't collect email - set to null explicitly
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
  
  // Turn-taking / anti-interrupt guardrails - IMPROVED
  let isSpeaking = false;
  let speakUntilTs = 0;
  let processing = false;
  let pendingFinal = null;
  let lastFinalAt = 0;
  let lastBotQuestionAt = 0; // Track when bot last asked a question
  
  const state = {
    name: "",
    zip: "",
    issueText: "",
    issueCategory: "general",
    askedFollowup: false,
    awaitingFollowupResponse: false,
    awaitingConfirmation: false,
    awaitingCorrectionChoice: false, // NEW: waiting for user to say what to correct
    correctingField: null, // NEW: which field we're correcting (zip, name, car, issue)
    confirmed: false,
    carMakeModel: "",
    carYear: "",
    drivable: "",
    urgency_window: "",
    leadCreated: false,
    // Track which step we're on to prevent wrong extractions
    currentStep: "issue", // issue, followup, car, name, zip, confirm
  };
  
  // Keep GPT as "backup"
  const messages = [
    {
      role: "system",
      content:
        "You are the MassMechanic phone agent. Keep replies SHORT (1 sentence). Ask ONE question at a time. " +
        "Goal: collect (1) what's wrong, (2) car make/model/year, (3) first name, (4) ZIP code. " +
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
      
      // CRITICAL: Add grace period after bot asks a question
      // Don't process user input for at least 800ms after bot finishes speaking
      const timeSinceBotQuestion = now - lastBotQuestionAt;
      if (timeSinceBotQuestion < 800) {
        // Schedule processing for after grace period
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
    // Require carMakeModel so lead insert doesn't violate NOT NULL
    return Boolean(state.issueText && state.carMakeModel && state.name && state.zip);
  }
  
  async function say(text) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !streamSid) return;
    
    console.log(`🤖 Bot: ${text}`);
    
    // Mark speaking to reduce user-talk-over
    isSpeaking = true;
    const ms = estimateSpeakMs(text);
    speakUntilTs = Date.now() + ms;
    lastBotQuestionAt = Date.now(); // Track when bot asks a question
    
    const ok = await speakOverStream({ ws, streamSid, text, deepgramKey: DEEPGRAM_API_KEY });
    
    if (!ok) {
      // if TTS fails, stop "speaking" state quickly
      speakUntilTs = Date.now() + 500;
      console.error("❌ TTS completely failed after retries");
    }
    
    // Release speaking flag after estimated duration + buffer
    setTimeout(() => {
      isSpeaking = false;
    }, ms + 500); // Add 500ms buffer
  }
  
  async function drainPendingFinal() {
    if (!pendingFinal) return;
    processing = true;
    
    try {
      // Grab the most recent final utterance and clear queue
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
      
      // Handle correction choice (user telling us what to fix)
      if (state.awaitingCorrectionChoice) {
        const lower = text.toLowerCase();
        
        if (/(zip|zip code|zipcode)/i.test(lower)) {
          state.correctingField = "zip";
          state.zip = ""; // Clear the field
          state.currentStep = "zip";
          state.awaitingCorrectionChoice = false;
          await say("Okay, what's your 5-digit ZIP code?");
          return;
        }
        
        if (/(name|first name)/i.test(lower)) {
          state.correctingField = "name";
          state.name = ""; // Clear the field
          state.currentStep = "name";
          state.awaitingCorrectionChoice = false;
          await say("Okay, what's your first name?");
          return;
        }
        
        if (/(car|vehicle|make|model)/i.test(lower)) {
          state.correctingField = "car";
          state.carMakeModel = ""; // Clear the field
          state.carYear = ""; // Also clear year
          state.currentStep = "car";
          state.awaitingCorrectionChoice = false;
          await say("Okay, what's the make and model of your car?");
          return;
        }
        
        if (/(issue|problem|wrong)/i.test(lower)) {
          state.correctingField = "issue";
          state.issueText = ""; // Clear the field
          state.currentStep = "issue";
          state.awaitingCorrectionChoice = false;
          await say("Okay, tell me what's wrong with your car.");
          return;
        }
        
        // If unclear, ask again
        await say("Sorry, I didn't catch that. Would you like to correct your ZIP code, your name, the car, or the issue?");
        return;
      }
      
      // If awaiting followup response, prioritize capturing that
      if (state.awaitingFollowupResponse) {
        // User is responding to our detailed follow-up question
        // Don't extract new data, just append to issue description
        if (text.length > 3) {
          state.issueText = `${state.issueText}. ${text}`;
          state.awaitingFollowupResponse = false;
          state.currentStep = "car"; // Move to next step
          console.log(`✅ Added followup details: ${text}`);
        }
      }
      
      // Extract data based on current step to prevent wrong extractions
      
      // Only extract ZIP when we're on the zip step
      if (state.currentStep === "zip" && !state.zip) {
        const z = extractZip(text);
        if (z) {
          state.zip = z;
          state.correctingField = null; // Done correcting
          console.log(`✅ Extracted ZIP: ${z}`);
        }
      }
      
      // Only extract name when we're on the name step
      if (state.currentStep === "name" && !state.name) {
        const n = extractName(text);
        if (n) {
          state.name = n;
          state.correctingField = null; // Done correcting
          console.log(`✅ Extracted name: ${n}`);
        }
      }
      
      // Only extract car when we're on the car step
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
            state.correctingField = null; // Done correcting
            console.log(`✅ Extracted car: ${mm}`);
          }
        }
      }
      
      // Capture issueText once (avoid overwriting with name/zip)
      if (state.currentStep === "issue" && !state.issueText) {
        const z = extractZip(text);
        const n = extractName(text);
        
        // If utterance is not just zip/name, treat as issue
        if (!z && !n && text.length > 6) {
          state.issueText = text;
          state.issueCategory = categorizeIssue(text);
          state.correctingField = null; // Done correcting
          console.log(`✅ Captured issue: ${text} (category: ${state.issueCategory})`);
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
            `Perfect — thanks, ${state.name}. We'll connect you with a trusted local mechanic near ZIP ${speakZipDigits(state.zip)}.`
          );
          return;
        }
        
        if (looksLikeNo(text)) {
          state.awaitingConfirmation = false;
          state.awaitingCorrectionChoice = true; // NEW: Set flag to wait for correction choice
          await say("No problem — what should I correct: your ZIP code, your name, the car, or the issue?");
          return;
        }
        
        // If unclear response during confirmation, ask again
        await say("Sorry, I didn't catch that. Is that information correct?");
        return;
      }
      
      // UPDATED FLOW ORDER: issue -> followup -> car -> name -> zip -> confirm
      
      // Step 1: Get the issue
      if (!state.issueText) {
        state.currentStep = "issue";
        await say("Tell me what's wrong with your car.");
        return;
      }
      
      // Step 2: Ask follow-up about the issue
      if (state.issueText && !state.askedFollowup) {
        state.askedFollowup = true;
        state.awaitingFollowupResponse = true;
        state.currentStep = "followup";
        const followup = FOLLOWUP_BY_CATEGORY[state.issueCategory] || FOLLOWUP_BY_CATEGORY.general;
        await say(followup);
        return;
      }
      
      // Step 3: Get car make/model/year
      if (!state.carMakeModel) {
        state.currentStep = "car";
        await say("What's the make and model of your car?");
        return;
      }
      
      // Step 4: Get name
      if (!state.name) {
        state.currentStep = "name";
        await say("And what's your first name?");
        return;
      }
      
      // Step 5: Get ZIP code
      if (!state.zip) {
        state.currentStep = "zip";
        await say("What's your 5-digit ZIP code?");
        return;
      }
      
      // Step 6: Confirmation (or re-confirmation after correction)
      if (readyToConfirm() && !state.confirmed && !state.awaitingConfirmation) {
        state.awaitingConfirmation = true;
        state.currentStep = "confirm";
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
      
      // If another final came in while processing, handle it now (latest wins)
      if (pendingFinal && !transferred) {
        setTimeout(() => {
          if (!processing && !(isSpeaking && Date.now() < speakUntilTs)) {
            drainPendingFinal();
          }
        }, 400); // Increased delay
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
      
      // Create/initialize call_outcomes row
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
      
      try { if (deepgramLive) deepgramLive.close(); } catch {}
      return;
    }
  });
  
  ws.on("close", async () => {
    try { if (deepgramLive) deepgramLive.close(); } catch {}
    
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

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

// Basic extraction helpers (not perfect, but useful)
function extractZip(text = "") {
  const m = text.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
}

function extractName(text = "") {
  // naive: “Tom”, “Tommy”, “John Smith”, “My name is ___”
  const m = text.match(/\b(my name is|this is|i'm|im)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)\b/i);
  if (m?.[2]) return m[2].trim();
  if (/^[A-Za-z]{2,}(?:\s+[A-Za-z]{2,})?$/.test(text.trim()) && text.trim().length <= 20) {
    return text.trim();
  }
  return "";
}

// Issue routing (keyword-based; tune freely)
function categorizeIssue(text = "") {
  const t = text.toLowerCase();

  // safety/driveability
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
  tire: "Is the tire flat right now, or losing air slowly? Do you know the tire size or vehicle model?",
  general: "Got it. What’s the make/model and roughly when did the issue start?"
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
// 4. VOICE SERVER (STREAM + BETTER ROUTING + CONFIRMATION HOOK)
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

  // Conversation state (guardrails + confirmation)
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
        "IMPORTANT: Do NOT end the call until you have CONFIRMED: Name + ZIP + Issue. " +
        "Before closing, ask: 'To confirm, you're in ZIP ___ and the issue is ___ — is that right?' " +
        "If the user says yes, close politely. If no, correct details and re-confirm. " +
        "The opening greeting has ALREADY been spoken, so do NOT repeat it."
    }
  ];

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
        processAiResponse(transcript);
      }
    });

    deepgramLive.on("error", (err) => console.error("DG Error:", err));
  };

  setupDeepgram();

  // Helper: decide if we can confirm
  function readyToConfirm() {
    return Boolean(state.name && state.zip && state.issueText);
  }

  const processAiResponse = async (text) => {
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

      // Lightweight extraction from user input (adds stability)
      if (!state.zip) {
        const z = extractZip(text);
        if (z) state.zip = z;
      }
      if (!state.name) {
        const n = extractName(text);
        if (n) state.name = n;
      }
      if (!state.issueText && text.length > 6) {
        // don't overwrite issueText once set
        // heuristically capture issue when user describes it (not when they say "Tom")
        if (!extractZip(text) && !extractName(text)) {
          state.issueText = text.trim();
          state.issueCategory = categorizeIssue(state.issueText);
        }
      }

      // If we’re awaiting confirmation, interpret yes/no
      if (state.awaitingConfirmation && !state.confirmed) {
        if (looksLikeYes(text)) {
          state.confirmed = true;
          state.awaitingConfirmation = false;

          const closing = `Perfect — thanks ${state.name || ""}. We’ll connect you with a local mechanic near ${state.zip}.`;
          messages.push({ role: "assistant", content: closing });
          await speakOverStream({ ws, streamSid, text: closing, deepgramKey: DEEPGRAM_API_KEY });
          return;
        }

        if (looksLikeNo(text)) {
          state.awaitingConfirmation = false;
          const fix = "No problem — what should I correct: your ZIP code, your name, or the issue?";
          messages.push({ role: "assistant", content: fix });
          await speakOverStream({ ws, streamSid, text: fix, deepgramKey: DEEPGRAM_API_KEY });
          return;
        }
        // if unclear, fall through to GPT
      }

      messages.push({ role: "user", content: text });

      // Deterministic follow-up: if we captured an issue and haven’t asked the category follow-up yet
      if (state.issueText && !state.askedFollowup) {
        state.askedFollowup = true;
        const followup = FOLLOWUP_BY_CATEGORY[state.issueCategory] || FOLLOWUP_BY_CATEGORY.general;
        messages.push({ role: "assistant", content: followup });
        await speakOverStream({ ws, streamSid, text: followup, deepgramKey: DEEPGRAM_API_KEY });
        return;
      }

      // Force confirmation when ready, before GPT can “wrap up”
      if (readyToConfirm() && !state.confirmed && !state.awaitingConfirmation) {
        state.awaitingConfirmation = true;
        const confirmLine = `To confirm, you're in ZIP ${state.zip} and the issue is: "${state.issueText}". Is that right?`;
        messages.push({ role: "assistant", content: confirmLine });
        await speakOverStream({ ws, streamSid, text: confirmLine, deepgramKey: DEEPGRAM_API_KEY });
        return;
      }

      // Otherwise, use GPT to continue the dialog
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
                `Ask ONE short question that helps you collect missing details.`
            }
          ],
          max_tokens: 120
        })
      });

      const gptJson = await gpt.json();

      // Guardrail: handle quota/rate limit cleanly
      const aiText = gptJson?.choices?.[0]?.message?.content?.trim();
      if (!aiText) {
        const fallback = "I’m having a quick technical issue. Please text us your ZIP and what’s going on, and we’ll follow up right away.";
        await speakOverStream({ ws, streamSid, text: fallback, deepgramKey: DEEPGRAM_API_KEY });
        return;
      }

      console.log(`🤖 AI: ${aiText}`);
      messages.push({ role: "assistant", content: aiText });

      await speakOverStream({
        ws,
        streamSid,
        text: aiText,
        deepgramKey: DEEPGRAM_API_KEY
      });
    } catch (e) {
      console.error("AI/TTS Error:", e);
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
      if (deepgramLive) deepgramLive.close();
      return;
    }
  });

  ws.on("close", () => {
    try { if (deepgramLive) deepgramLive.close(); } catch {}
  });
});

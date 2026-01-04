import express from "express";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

// ───────────────────────────────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────────────────────────────
function normalizePhone(phone = "") {
  const digits = String(phone).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.startsWith("+")) return digits;
  return `+${digits}`;
}

function getBaseUrlFromReq(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}

function getStreamUrl(req) {
  // Render/proxies often forward the real host here
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] || "https").includes("https") ? "wss" : "ws";
  return `${proto}://${host}/`;
}

// ───────────────────────────────────────────────────────────────────────────────
// 1. CONFIGURATION & SETUP
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Load Env Vars
const {
  OPENAI_API_KEY,
  DEEPGRAM_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  SUPABASE_URL,
  SUPABASE_KEY,
  PUBLIC_BASE_URL,           // ✅ add: https://mass-mechanic-bot.onrender.com
  ADMIN_ESCALATION_PHONE     // ✅ add: +16782003064
} = process.env;

if (
  !OPENAI_API_KEY ||
  !DEEPGRAM_API_KEY ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !SUPABASE_URL ||
  !SUPABASE_KEY ||
  !TWILIO_PHONE_NUMBER
) {
  console.error("❌ CRITICAL: Missing API Keys.");
  process.exit(1);
}

if (!PUBLIC_BASE_URL) {
  console.warn("⚠️ PUBLIC_BASE_URL missing. Set it to https://mass-mechanic-bot.onrender.com for reliable transfers.");
}

if (!ADMIN_ESCALATION_PHONE) {
  console.warn("⚠️ ADMIN_ESCALATION_PHONE missing. Escalation will not be able to transfer calls.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ───────────────────────────────────────────────────────────────────────────────
// 2. HEALTH CHECK
// ───────────────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Mass Mechanic Server is Awake 🤖"));

// ───────────────────────────────────────────────────────────────────────────────
// 3. SMS WORKER (Service Advisor) — unchanged
// ───────────────────────────────────────────────────────────────────────────────
async function extractAndDispatchLead(history, userPhone) {
  console.log("🧠 Processing Lead for Dispatch...");
  const extractionPrompt = `Analyze extract lead details: name, car_year, car_make_model, zip_code, description, service_type, drivable (Yes/No), urgency_window (Today/Flexible). If drivable implies towing, set No.`;

  try {
    const gptExtract = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: extractionPrompt },
          { role: "user", content: JSON.stringify(history) }
        ],
        response_format: { type: "json_object" }
      })
    });

    const extractData = await gptExtract.json();
    const leadDetails = JSON.parse(extractData.choices?.[0]?.message?.content || "{}");

    const { data: insertedLead, error: insertError } = await supabase
      .from("leads")
      .insert({
        phone: userPhone,
        source: "sms_bot",
        name: leadDetails.name || "SMS User",
        car_year: leadDetails.car_year,
        car_make_model: leadDetails.car_make_model,
        zip_code: leadDetails.zip_code,
        description: leadDetails.description,
        service_type: leadDetails.service_type || "other",
        drivable: leadDetails.drivable || "Not sure",
        urgency_window: leadDetails.urgency_window || "Flexible"
      })
      .select()
      .single();

    if (insertError) throw insertError;

    const maintenanceServices = ["oil-change", "state-inspection", "tune-up", "tire-rotation"];
    if (maintenanceServices.includes(leadDetails.service_type)) {
      await supabase.functions.invoke("send-maintenance-lead-to-mechanics", { body: { lead_id: insertedLead.id } });
    } else {
      await supabase.functions.invoke("send-lead-to-mechanics", { body: { lead_id: insertedLead.id } });
    }
  } catch (e) {
    console.error("❌ Dispatch Failed:", e);
  }
}

app.post("/sms", async (req, res) => {
  const incomingMsg = req.body.body || req.body.Body;
  const fromNumberRaw = req.body.from || req.body.From;
  const fromNumber = normalizePhone(fromNumberRaw);

  res.status(200).send("OK");
  if (!incomingMsg || !fromNumber) return;

  const systemPrompt = `You are the Senior Service Advisor for Mass Mechanic. Qualify this lead. Gather: Name, Car, Zip, Issue, Drivability (Yes/No), Urgency (Today/Flexible). Rules: Check history first. Ask 1 question at a time. Once done say: "Perfect. I have sent your request to our network."`;

  try {
    const { data: history } = await supabase
      .from("sms_chat_history")
      .select("role, content")
      .eq("phone", fromNumber)
      .order("created_at", { ascending: true })
      .limit(12);

    const pastMessages = (history || []).map((msg) => ({ role: msg.role, content: msg.content }));

    const gptResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "system", content: systemPrompt }, ...pastMessages, { role: "user", content: incomingMsg }],
        max_tokens: 200
      })
    });

    const replyText = (await gptResponse.json()).choices?.[0]?.message?.content || "";
    await supabase.from("sms_chat_history").insert([
      { phone: fromNumber, role: "user", content: incomingMsg },
      { phone: fromNumber, role: "assistant", content: replyText }
    ]);

    await twilioClient.messages.create({ body: replyText, from: TWILIO_PHONE_NUMBER, to: fromNumber });

    if (replyText.toLowerCase().includes("sent your request")) {
      extractAndDispatchLead([...pastMessages, { role: "user", content: incomingMsg }, { role: "assistant", content: replyText }], fromNumber);
    }
  } catch (error) {
    console.error("❌ SMS Error:", error);
  }
});

// ────────────────────────────────────────────────────────────
// 4. VOICE SERVER (STREAM + INSTANT GREETING + SAFE TRANSFER)
// ────────────────────────────────────────────────────────────

const VOICE_GREETING =
  "Thanks for calling MassMechanic — we connect you with trusted local mechanics for fast, free repair quotes. " +
  "Are you calling about a repair you need help with right now, or do you have a quick question?";

// ✅ Stable TwiML transfer endpoint (Twilio updates call → this URL)
app.post("/transfer", (req, res) => {
  res.type("text/xml");

  if (!ADMIN_ESCALATION_PHONE) {
    return res.send(`<Response><Say>Sorry, we cannot connect you right now.</Say></Response>`);
  }

  res.send(`
    <Response>
      <Say>Connecting you now.</Say>
      <Dial>${ADMIN_ESCALATION_PHONE}</Dial>
    </Response>
  `);
});

async function transferCallToHuman(callSid) {
  if (!callSid) return;
  if (!PUBLIC_BASE_URL) {
    console.error("❌ PUBLIC_BASE_URL is missing — cannot transfer reliably.");
    return;
  }

  try {
    await twilioClient.calls(callSid).update({
      method: "POST",
      url: `${PUBLIC_BASE_URL}/transfer`
    });
  } catch (e) {
    console.error("❌ Twilio transfer failed:", e);
  }
}

async function sendEscalationSummary({ phone, channel, trigger, last_message }) {
  try {
    // Best-guess payload. If your edge function expects different keys,
    // this is the only place you need to tweak.
    await supabase.functions.invoke("send-escalation-summary", {
      body: {
        phone,
        channel,
        trigger,
        last_message
      }
    });
  } catch (e) {
    console.error("❌ send-escalation-summary failed:", e);
  }
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
    ws.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: base64Audio }
      })
    );
  }
}

// ✅ Voice webhook TwiML — passes From/Caller/CallSid into stream
app.post("/", (req, res) => {
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

const server = app.listen(PORT, () => console.log(`✅ MassMechanic Running on ${PORT}`));
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  console.log("🔗 Voice Connected");

  let streamSid = null;
  let callSid = null;
  let callerPhone = "unknown";
  let deepgramLive = null;

  let greeted = false;
  let escalated = false; // ✅ one-time escalation guard

  // --- MEMORY ---
  let messages = [
    {
      role: "system",
      content:
        "You are the MassMechanic phone agent. Keep answers SHORT (1–2 sentences). " +
        "Your goal: collect Name, ZIP code, and the car issue. Be friendly and direct. " +
        "The opening greeting has ALREADY been spoken to the caller, so do NOT repeat it. " +
        "After the greeting, ask ONE simple follow-up question based on what they say."
    }
  ];

  // 1) SETUP DEEPGRAM (LISTENER)
  const setupDeepgram = () => {
    deepgramLive = new WebSocket(
      "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&model=nova-2&smart_format=true",
      { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
    );

    deepgramLive.on("open", () => console.log("🟢 Deepgram Listening"));

    deepgramLive.on("message", (data) => {
      const received = JSON.parse(data);
      const transcript = received.channel?.alternatives?.[0]?.transcript;

      if (transcript && received.is_final && transcript.trim().length > 0) {
        console.log(`🗣️ User: ${transcript}`);
        handleVoiceText(transcript);
      }
    });

    deepgramLive.on("error", (err) => console.error("DG Error:", err));
  };

  setupDeepgram();

  // 2) HANDLE VOICE TEXT (routing + escalation)
  const handleVoiceText = async (text) => {
    const lower = text.toLowerCase();

    // ✅ Human request detection (simple + effective)
    const wantsHuman =
      lower.includes("operator") ||
      lower.includes("representative") ||
      lower.includes("human") ||
      lower.includes("agent") ||
      lower.includes("someone") ||
      lower.includes("talk to a person");

    if (wantsHuman && !escalated) {
      escalated = true;

      // Send escalation summary to your admin SMS (via Supabase edge)
      await sendEscalationSummary({
        phone: callerPhone,
        channel: "voice",
        trigger: "REQUESTED_HUMAN",
        last_message: text
      });

      // Transfer call to human
      await transferCallToHuman(callSid);

      return;
    }

    // Normal AI flow
    await processAiResponse(text);
  };

  // 3) AI BRAIN (WITH MEMORY)
  const processAiResponse = async (text) => {
    try {
      messages.push({ role: "user", content: text });

      const gpt = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages,
          max_tokens: 120
        })
      });

      const aiText = (await gpt.json()).choices?.[0]?.message?.content?.trim();
      if (!aiText) return;

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

  // 4) TWILIO STREAM HANDLER
  ws.on("message", async (msg) => {
    const data = JSON.parse(msg);

    if (data.event === "start") {
      streamSid = data.start.streamSid;

      // ✅ Pull our custom params reliably
      const params = data.start?.customParameters || {};
      const pFrom = normalizePhone(params.from || "");
      const pCaller = normalizePhone(params.caller || "");
      callerPhone = pFrom || pCaller || "unknown";

      callSid = params.callSid || data.start.callSid || callSid;

      // 🔥 Speak immediately on start (no silence)
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
    if (deepgramLive) deepgramLive.close();
  });
});

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

  // NEW (set in Render):
  PUBLIC_BASE_URL,          // e.g. https://mass-mechanic-bot.onrender.com
  ADMIN_ESCALATION_PHONE    // e.g. +16782003064
} = process.env;

if (
  !OPENAI_API_KEY ||
  !DEEPGRAM_API_KEY ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !SUPABASE_URL ||
  !SUPABASE_KEY
) {
  console.error("❌ CRITICAL: Missing API Keys.");
  process.exit(1);
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
  const extractionPrompt =
    `Analyze extract lead details: name, car_year, car_make_model, zip_code, description, service_type, drivable (Yes/No), urgency_window (Today/Flexible). If drivable implies towing, set No.`;

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
    const leadDetails = JSON.parse(extractData.choices[0].message.content);

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
  const fromNumber = req.body.from || req.body.From;

  res.status(200).send("OK");
  if (!incomingMsg || !fromNumber) return;

  const systemPrompt =
    `You are the Senior Service Advisor for Mass Mechanic. Qualify this lead. Gather: Name, Car, Zip, Issue, Drivability (Yes/No), Urgency (Today/Flexible).
Rules: Check history first. Ask 1 question at a time. Once done say: "Perfect. I have sent your request to our network."`;

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

    const replyJson = await gptResponse.json();
    const replyText = replyJson?.choices?.[0]?.message?.content;

    await supabase.from("sms_chat_history").insert([
      { phone: fromNumber, role: "user", content: incomingMsg },
      { phone: fromNumber, role: "assistant", content: replyText }
    ]);

    await twilioClient.messages.create({
      body: replyText,
      from: TWILIO_PHONE_NUMBER,
      to: fromNumber
    });

    if (replyText?.includes("sent your request")) {
      extractAndDispatchLead(
        [...pastMessages, { role: "user", content: incomingMsg }, { role: "assistant", content: replyText }],
        fromNumber
      );
    }
  } catch (error) {
    console.error("❌ SMS Error:", error);
  }
});

// ────────────────────────────────────────────────────────────
// 4. VOICE SERVER (STREAM + INSTANT GREETING + HUMAN ESCALATION)
// ────────────────────────────────────────────────────────────

const VOICE_GREETING =
  "Thanks for calling MassMechanic — we connect you with trusted local mechanics for fast, free repair quotes. " +
  "Are you calling about a repair you need help with right now, or do you have a quick question?";

function getStreamUrl(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const xfProto = req.headers["x-forwarded-proto"] || "https";
  const proto = String(xfProto).includes("https") ? "wss" : "ws";
  return `${proto}://${host}/`; // websocket upgrade path
}

/**
 * ✅ FIXED: Stream audio back to Twilio in 20ms frames.
 * mulaw 8k: 8000 bytes/sec => 20ms = 160 bytes
 */
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

  const audio = Buffer.from(await ttsResponse.arrayBuffer());
  if (ws.readyState !== WebSocket.OPEN || !streamSid) return;

  const FRAME_SIZE = 160; // 20ms
  for (let i = 0; i < audio.length; i += FRAME_SIZE) {
    const chunk = audio.subarray(i, i + FRAME_SIZE);
    ws.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: chunk.toString("base64") }
      })
    );
    await sleep(20);
  }
}

async function sendVoiceEscalationSummary({ callerPhone, trigger, lastMessage }) {
  try {
    await supabase.functions.invoke("send-escalation-summary", {
      body: {
        phone: callerPhone,
        channel: "voice",
        trigger,
        last_message: lastMessage
      }
    });
    console.log("✅ Escalation summary invoked");
  } catch (e) {
    console.error("❌ send-escalation-summary failed:", e);
  }
}

async function transferCallToHuman(callSid) {
  if (!ADMIN_ESCALATION_PHONE) {
    console.error("❌ Missing ADMIN_ESCALATION_PHONE env var");
    return;
  }
  if (!callSid) {
    console.error("❌ Missing callSid — cannot transfer");
    return;
  }

  const baseUrl = (PUBLIC_BASE_URL || "https://mass-mechanic-bot.onrender.com").replace(/\/$/, "");
  const transferUrl = `${baseUrl}/transfer`;

  await twilioClient.calls(callSid).update({
    url: transferUrl,
    method: "POST"
  });

  console.log("📞 Call transfer initiated", { callSid, transferUrl });
}

// ✅ Voice webhook TwiML — passes From/Caller/CallSid into stream
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

// ✅ Transfer TwiML endpoint (prevents 11200)
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
  console.log("🔗 Voice Connected (WS)");

  let streamSid = null;
  let deepgramLive = null;
  let greeted = false;

  let callerPhone = "unknown";
  let callSid = "";
  let transferred = false;

  // prevents overlapping/stacked speech if user talks rapidly
  let busy = false;

  let messages = [
    {
      role: "system",
      content:
        "You are the MassMechanic phone agent. Keep answers SHORT (1–2 sentences). " +
        "Your goal: collect Name, ZIP code, and the car issue. Be friendly and direct. " +
        "The opening greeting has ALREADY been spoken to the caller, so do NOT repeat it. " +
        "Ask ONE follow-up question at a time."
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

  const processAiResponse = async (text) => {
    if (transferred) return;
    if (busy) return; // simple guard; keeps it stable
    busy = true;

    try {
      // Human request escalation
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

      messages.push({ role: "user", content: text });

      console.log("🧠 Sending to OpenAI:", text);

      const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          messages,
          max_tokens: 120
        })
      });

      const gptJson = await gptRes.json();
      const aiText = gptJson?.choices?.[0]?.message?.content?.trim();

      if (!aiText) {
        console.error("❌ OpenAI returned no text:", JSON.stringify(gptJson).slice(0, 500));
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
    } finally {
      busy = false;
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

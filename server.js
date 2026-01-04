import express from "express";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

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
  SUPABASE_SERVICE_ROLE_KEY,
  ADMIN_ESCALATION_PHONE,
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

// NOTE: You are using SUPABASE_KEY already. If you have a Service Role key,
// set SUPABASE_SERVICE_ROLE_KEY in Render and we’ll use it for Edge function calls.
const SUPABASE_EDGE_AUTH = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ───────────────────────────────────────────────────────────────────────────────
// 2. HEALTH CHECK
// ───────────────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Mass Mechanic Server is Awake 🤖"));

// ───────────────────────────────────────────────────────────────────────────────
// 3. SMS WORKER (Service Advisor)
// ───────────────────────────────────────────────────────────────────────────────
async function extractAndDispatchLead(history, userPhone) {
  console.log("🧠 Processing Lead for Dispatch...");
  const extractionPrompt =
    `Analyze extract lead details: name, car_year, car_make_model, zip_code, description, ` +
    `service_type, drivable (Yes/No), urgency_window (Today/Flexible). ` +
    `If drivable implies towing, set No.`;

  try {
    const gptExtract = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: extractionPrompt },
          { role: "user", content: JSON.stringify(history) },
        ],
        response_format: { type: "json_object" },
      }),
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
        urgency_window: leadDetails.urgency_window || "Flexible",
      })
      .select()
      .single();

    if (insertError) throw insertError;

    const maintenanceServices = ["oil-change", "state-inspection", "tune-up", "tire-rotation"];
    if (maintenanceServices.includes(leadDetails.service_type)) {
      await supabase.functions.invoke("send-maintenance-lead-to-mechanics", {
        body: { lead_id: insertedLead.id },
      });
    } else {
      await supabase.functions.invoke("send-lead-to-mechanics", {
        body: { lead_id: insertedLead.id },
      });
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
    `You are the Senior Service Advisor for Mass Mechanic. Qualify this lead. Gather: ` +
    `Name, Car, Zip, Issue, Drivability (Yes/No), Urgency (Today/Flexible). ` +
    `Rules: Check history first. Ask 1 question at a time. Once done say: ` +
    `"Perfect. I have sent your request to our network."`;

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
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "system", content: systemPrompt }, ...pastMessages, { role: "user", content: incomingMsg }],
        max_tokens: 200,
      }),
    });

    const replyText = (await gptResponse.json()).choices[0].message.content;
    await supabase.from("sms_chat_history").insert([
      { phone: fromNumber, role: "user", content: incomingMsg },
      { phone: fromNumber, role: "assistant", content: replyText },
    ]);

    await twilioClient.messages.create({
      body: replyText,
      from: TWILIO_PHONE_NUMBER,
      to: fromNumber,
    });

    if (replyText.includes("sent your request")) {
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
// 4. VOICE SERVER (STREAM + INSTANT GREETING + ESCALATION)
// ────────────────────────────────────────────────────────────

const VOICE_GREETING =
  "Thanks for calling MassMechanic — we connect you with trusted local mechanics for fast, free repair quotes. " +
  "Are you calling about a repair you need help with right now, or do you have a quick question?";

const CONNECTING_LINE =
  "Got it. One moment while I connect you now.";

function getStreamUrl(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] || "https").includes("https") ? "wss" : "ws";
  return `${proto}://${host}/`;
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
    return;
  }

  const audioBuffer = await ttsResponse.arrayBuffer();
  const base64Audio = Buffer.from(audioBuffer).toString("base64");

  if (ws.readyState === WebSocket.OPEN && streamSid) {
    ws.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: base64Audio },
      })
    );
  }
}

function normalizePhone(p) {
  if (!p) return "";
  const digits = String(p).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (String(p).startsWith("+")) return String(p);
  return `+${digits}`;
}

function shouldEscalateVoice(text) {
  const t = (text || "").toLowerCase();

  // Human request triggers
  const wantsHuman =
    t.includes("human") ||
    t.includes("representative") ||
    t.includes("real person") ||
    t.includes("operator") ||
    t.includes("agent") ||
    t.includes("someone") && t.includes("talk");

  // Emergency-ish / unsafe triggers (don’t mention towing; just escalate)
  const emergency =
    t.includes("accident") ||
    t.includes("crash") ||
    t.includes("hit") && t.includes("car") ||
    t.includes("highway") ||
    t.includes("freeway") ||
    t.includes("shoulder") ||
    t.includes("stuck") ||
    t.includes("danger") ||
    t.includes("unsafe") ||
    t.includes("stranded") ||
    t.includes("smoke") ||
    t.includes("fire") ||
    t.includes("leaking") && (t.includes("fuel") || t.includes("gas")) ||
    t.includes("police") ||
    t.includes("ambulance");

  if (wantsHuman) return { escalate: true, reason: "REQUESTED_HUMAN" };
  if (emergency) return { escalate: true, reason: "EMERGENCY_RISK" };
  return { escalate: false, reason: null };
}

async function callSendEscalationSummary({ phone, channel, reason, last_message }) {
  try {
    // If you ever change your project ref, this stays stable because it uses SUPABASE_URL.
    const url = `${SUPABASE_URL}/functions/v1/send-escalation-summary`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_EDGE_AUTH}`,
        apikey: SUPABASE_EDGE_AUTH,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        phone,
        channel,
        reason,
        last_message,
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      console.error("❌ send-escalation-summary failed:", resp.status, txt);
    }
  } catch (e) {
    console.error("❌ send-escalation-summary error:", e);
  }
}

async function transferCallToHuman({ callSid }) {
  if (!ADMIN_ESCALATION_PHONE) {
    console.error("❌ Missing ADMIN_ESCALATION_PHONE env var — cannot transfer call.");
    return;
  }

  try {
    // Update the live call to dial you.
    const twiml = `
      <Response>
        <Dial>${ADMIN_ESCALATION_PHONE}</Dial>
      </Response>
    `;
    await twilioClient.calls(callSid).update({ twiml });
  } catch (e) {
    console.error("❌ Twilio transfer failed:", e);
  }
}

// Twilio Voice webhook (initial call answer)
// IMPORTANT: We attach From + CallSid as <Parameter> so we can read them inside WS "start".
app.post("/", (req, res) => {
  res.type("text/xml");

  const streamUrl = getStreamUrl(req);
  const from = normalizePhone(req.body?.From || "");
  const callSid = req.body?.CallSid || "";

  res.send(`
    <Response>
      <Connect>
        <Stream url="${streamUrl}">
          <Parameter name="from" value="${from}" />
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
  let callerPhone = null;

  let deepgramLive = null;
  let greeted = false;
  let escalated = false;

  // --- MEMORY: Store the conversation context here ---
  let messages = [
    {
      role: "system",
      content:
        "You are the MassMechanic phone agent. Keep answers SHORT (1–2 sentences). " +
        "Your goal: collect Name, ZIP code, and the car issue. Be friendly and direct. " +
        "The opening greeting has ALREADY been spoken to the caller, so do NOT repeat it. " +
        "After the greeting, your next step is to ask ONE simple follow-up question based on what they say.",
    },
  ];

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

        // Escalation check BEFORE AI responds
        const decision = shouldEscalateVoice(transcript);
        if (decision.escalate && !escalated) {
          escalated = true;

          // Best-effort: speak one line so they know what’s happening
          speakOverStream({
            ws,
            streamSid,
            text: CONNECTING_LINE,
            deepgramKey: DEEPGRAM_API_KEY,
          }).catch(() => {});

          // Send escalation summary (idempotent on Supabase side)
          callSendEscalationSummary({
            phone: callerPhone || "unknown",
            channel: "voice",
            reason: decision.reason,
            last_message: transcript,
          }).catch(() => {});

          // Transfer live call to you
          if (callSid) {
            transferCallToHuman({ callSid }).catch(() => {});
          } else {
            console.error("❌ No callSid available to transfer.");
          }
          return;
        }

        // Normal AI flow
        processAiResponse(transcript);
      }
    });

    deepgramLive.on("error", (err) => console.error("DG Error:", err));
  };

  setupDeepgram();

  const processAiResponse = async (text) => {
    // If escalated, do nothing further
    if (escalated) return;

    try {
      messages.push({ role: "user", content: text });

      const gpt = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages,
          max_tokens: 120,
        }),
      });

      const aiText = (await gpt.json()).choices[0].message.content?.trim();
      if (!aiText) return;

      console.log(`🤖 AI: ${aiText}`);
      messages.push({ role: "assistant", content: aiText });

      await speakOverStream({
        ws,
        streamSid,
        text: aiText,
        deepgramKey: DEEPGRAM_API_KEY,
      });
    } catch (e) {
      console.error("AI/TTS Error:", e);
    }
  };

  ws.on("message", async (msg) => {
    const data = JSON.parse(msg);

    if (data.event === "start") {
      streamSid = data.start.streamSid;

      // Pull our custom parameters from Twilio
      const params = data.start?.customParameters || {};
      callerPhone = normalizePhone(params.from || "");
      callSid = params.callSid || data.start.callSid || null;

      // Speak immediately on start
      if (!greeted) {
        greeted = true;

        // Add greeting to memory so model stays aligned
        messages.push({ role: "assistant", content: VOICE_GREETING });

        await speakOverStream({
          ws,
          streamSid,
          text: VOICE_GREETING,
          deepgramKey: DEEPGRAM_API_KEY,
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
});

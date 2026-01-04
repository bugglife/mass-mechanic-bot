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
  SUPABASE_KEY
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
app.get('/', (req, res) => res.send("Mass Mechanic Server is Awake 🤖"));

// ───────────────────────────────────────────────────────────────────────────────
// 3. SMS WORKER (Service Advisor)
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
                messages: [{ role: "system", content: extractionPrompt }, { role: "user", content: JSON.stringify(history) }],
                response_format: { type: "json_object" }
            })
        });

        const extractData = await gptExtract.json();
        const leadDetails = JSON.parse(extractData.choices[0].message.content);
        
        const { data: insertedLead, error: insertError } = await supabase
            .from('leads')
            .insert({
                phone: userPhone,
                source: 'sms_bot',
                name: leadDetails.name || 'SMS User',
                car_year: leadDetails.car_year,
                car_make_model: leadDetails.car_make_model,
                zip_code: leadDetails.zip_code,
                description: leadDetails.description,
                service_type: leadDetails.service_type || 'other',
                drivable: leadDetails.drivable || 'Not sure',
                urgency_window: leadDetails.urgency_window || 'Flexible'
            })
            .select()
            .single();

        if (insertError) throw insertError;

        const maintenanceServices = ['oil-change', 'state-inspection', 'tune-up', 'tire-rotation'];
        if (maintenanceServices.includes(leadDetails.service_type)) {
            await supabase.functions.invoke('send-maintenance-lead-to-mechanics', { body: { lead_id: insertedLead.id } });
        } else {
            await supabase.functions.invoke('send-lead-to-mechanics', { body: { lead_id: insertedLead.id } });
        }
    } catch (e) { console.error("❌ Dispatch Failed:", e); }
}

app.post('/sms', async (req, res) => {
    const incomingMsg = req.body.body || req.body.Body; 
    const fromNumber = req.body.from || req.body.From;
    res.status(200).send("OK");
    if (!incomingMsg || !fromNumber) return;

    const systemPrompt = `You are the Senior Service Advisor for Mass Mechanic. Qualify this lead. Gather: Name, Car, Zip, Issue, Drivability (Yes/No), Urgency (Today/Flexible). Rules: Check history first. Ask 1 question at a time. Once done say: "Perfect. I have sent your request to our network."`;

    try {
        const { data: history } = await supabase.from('sms_chat_history').select('role, content').eq('phone', fromNumber).order('created_at', { ascending: true }).limit(12);
        const pastMessages = (history || []).map(msg => ({ role: msg.role, content: msg.content }));
        
        const gptResponse = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "gpt-4o", 
                messages: [{ role: "system", content: systemPrompt }, ...pastMessages, { role: "user", content: incomingMsg }],
                max_tokens: 200
            })
        });

        const replyText = (await gptResponse.json()).choices[0].message.content;
        await supabase.from('sms_chat_history').insert([{ phone: fromNumber, role: 'user', content: incomingMsg }, { phone: fromNumber, role: 'assistant', content: replyText }]);
        await twilioClient.messages.create({ body: replyText, from: TWILIO_PHONE_NUMBER, to: fromNumber });

        if (replyText.includes("sent your request")) {
            extractAndDispatchLead([...pastMessages, { role: "user", content: incomingMsg }, { role: "assistant", content: replyText }], fromNumber);
        }
    } catch (error) { console.error("❌ SMS Error:", error); }
});

// ────────────────────────────────────────────────────────────
// 4. VOICE SERVER (STREAM + INSTANT GREETING)
// ────────────────────────────────────────────────────────────

const VOICE_GREETING =
  "Thanks for calling MassMechanic — we connect you with trusted local mechanics for fast, free repair quotes. " +
  "Are you calling about a repair you need help with right now, or do you have a quick question?";

function getStreamUrl(req) {
  // Render / proxies often forward the real host here
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] || "https").includes("https") ? "wss" : "ws";
  return `${proto}://${host}/`;
}

async function speakOverStream({ ws, streamSid, text, deepgramKey }) {
  // Deepgram TTS → mulaw 8k payload for Twilio Media Streams
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

app.post("/", (req, res) => {
  res.type("text/xml");

  // IMPORTANT: Don’t rely on <Say> for the first utterance.
  // We speak immediately once the stream starts (WS "start" event).
  const streamUrl = getStreamUrl(req);

  res.send(`
    <Response>
      <Connect>
        <Stream url="${streamUrl}" />
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
  let deepgramLive = null;
  let greeted = false;

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
    // We’ll also insert the greeting as an assistant message once it’s spoken
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

      // Only react to real final speech
      if (transcript && received.is_final && transcript.trim().length > 0) {
        console.log(`🗣️ User: ${transcript}`);
        processAiResponse(transcript);
      }
    });

    deepgramLive.on("error", (err) => console.error("DG Error:", err));
  };

  setupDeepgram();

  // 2) AI BRAIN (WITH MEMORY)
  const processAiResponse = async (text) => {
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

  // 3) TWILIO STREAM HANDLER
  ws.on("message", async (msg) => {
    const data = JSON.parse(msg);

    if (data.event === "start") {
      streamSid = data.start.streamSid;

      // 🔥 Speak immediately on start (so caller never hears silence)
      if (!greeted) {
        greeted = true;

        // Add greeting to memory so the model stays aligned
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

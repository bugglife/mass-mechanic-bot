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

// Middleware to parse JSON (from Supabase) and Form Data (from Twilio)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Load Environment Variables
const {
  OPENAI_API_KEY,
  DEEPGRAM_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  SUPABASE_URL,
  SUPABASE_KEY
} = process.env;

// Validation
if (!OPENAI_API_KEY || !DEEPGRAM_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ CRITICAL: Missing API Keys in .env file.");
  process.exit(1);
}

// Initialize Clients
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ───────────────────────────────────────────────────────────────────────────────
// 2. HEALTH CHECK (For Cron-Job.org)
// ───────────────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send("Mass Mechanic Server is Awake 🤖");
});

// ───────────────────────────────────────────────────────────────────────────────
// 3. SMS WORKER LOGIC (The "Service Advisor")
// ───────────────────────────────────────────────────────────────────────────────

// Helper: Extract Data & Dispatch to Edge Functions
async function extractAndDispatchLead(history, userPhone) {
    console.log("🧠 Processing Lead for Dispatch...");

    const extractionPrompt = `
    Analyze this SMS conversation and extract the lead details into JSON.
    
    FIELDS TO EXTRACT:
    - name: (String)
    - car_year: (String)
    - car_make_model: (String)
    - zip_code: (String, 5 digits)
    - description: (String, the core issue)
    
    CRITICAL SCORING FIELDS:
    - service_type: (Map to ONE: 'oil-change', 'state-inspection', 'tune-up', 'tire-rotation', 'no-start', 'brake-repair', 'check-engine-light', 'suspension-repair', 'exhaust-repair', 'battery-replacement', 'overheating', 'other')
    - drivable: (Map to ONE: 'Yes', 'No', 'Not sure')
    - urgency_window: (Map to ONE: 'Today', '1-2 days', 'This week', 'Flexible')

    RULES: 
    - If 'drivable' implies towing (wont start, stuck), set 'No'. 
    - If 'urgency' is not stated, default to 'Flexible'.
    `;

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
        
        console.log("📝 Extracted Data:", leadDetails);

        // 1. Insert into 'leads' table
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

        if (insertError) throw new Error(insertError.message);

        // 2. Routing Logic (Maintenance vs Repair)
        const maintenanceServices = ['oil-change', 'state-inspection', 'tune-up', 'tire-rotation'];
        const isMaintenance = maintenanceServices.includes(leadDetails.service_type);

        if (isMaintenance) {
            console.log("🔧 Maintenance Lead -> Routing to Subscription Pool...");
            await supabase.functions.invoke('send-maintenance-lead-to-mechanics', {
                body: { lead_id: insertedLead.id }
            });
        } else {
            console.log("🚨 Repair Lead -> Routing to Urgent Blast...");
            await supabase.functions.invoke('send-lead-to-mechanics', {
                body: { lead_id: insertedLead.id }
            });
        }

        console.log("🚀 Dispatch Complete.");

    } catch (e) {
        console.error("❌ Dispatch Failed:", e);
    }
}

// Route: Handle Incoming SMS (from Supabase Router)
app.post('/sms', async (req, res) => {
    // Input Handling (JSON from Supabase, or Form from Twilio Fallback)
    const incomingMsg = req.body.body || req.body.Body; 
    const fromNumber = req.body.from || req.body.From;
    
    // Acknowledge immediately (200 OK) so upstream doesn't timeout
    res.status(200).send("OK");

    if (!incomingMsg || !fromNumber) return;

    console.log(`📩 SMS from ${fromNumber}: ${incomingMsg}`);

    // System Prompt (Service Advisor Persona)
    const systemPrompt = `
    You are the Senior Service Advisor for Mass Mechanic.
    
    GOAL: Qualify this lead. Gather details to score the lead.
    
    GATHER THESE 6 ITEMS:
    1. Name
    2. Car Year/Make/Model
    3. Zip Code
    4. Issue Description
    5. Drivability ("Is it drivable or need a tow?") -> Critical for Scoring
    6. Urgency ("Need it today or flexible?") -> Critical for Scoring

    RULES:
    - CHECK HISTORY: If the user answered a question implicitly (e.g. "Can I come tomorrow?" = Urgency), accept it.
    - Ask 1 question at a time.
    - Once you have ALL 6, say EXACTLY: "Perfect. I have sent your request to our network. A shop will text you shortly with a quote."
    `;

    try {
        // Retrieve History
        const { data: history } = await supabase
            .from('sms_chat_history')
            .select('role, content')
            .eq('phone', fromNumber)
            .order('created_at', { ascending: true }) 
            .limit(12);

        const pastMessages = (history || []).map(msg => ({ role: msg.role, content: msg.content }));
        
        // Generate Reply
        const gptResponse = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "gpt-4o", 
                messages: [
                    { role: "system", content: systemPrompt },
                    ...pastMessages,
                    { role: "user", content: incomingMsg }
                ],
                max_tokens: 200
            })
        });

        const data = await gptResponse.json();
        const replyText = data.choices[0].message.content;

        // Save History
        await supabase.from('sms_chat_history').insert([
            { phone: fromNumber, role: 'user', content: incomingMsg },
            { phone: fromNumber, role: 'assistant', content: replyText }
        ]);

        // Send Reply via API
        await twilioClient.messages.create({
            body: replyText,
            from: TWILIO_PHONE_NUMBER,
            to: fromNumber
        });
        console.log(`📤 Reply Sent: ${replyText}`);

        // Check for Completion -> Trigger Extraction
        if (replyText.includes("sent your request")) {
            extractAndDispatchLead([...pastMessages, { role: "user", content: incomingMsg }, { role: "assistant", content: replyText }], fromNumber);
        }

    } catch (error) {
        console.error("❌ SMS Error:", error);
    }
});

// ───────────────────────────────────────────────────────────────────────────────
// 4. VOICE LOGIC (The "Ear" - Deepgram & WebSocket)
// ───────────────────────────────────────────────────────────────────────────────

// Route: Twilio Voice Webhook (Entry Point)
app.post('/', (req, res) => {
  res.type("text/xml");
  // Tells Twilio to connect audio stream to our WebSocket
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${req.headers.host}/" />
      </Connect>
    </Response>
  `);
});

// Start the Express Server
const server = app.listen(PORT, () => {
  console.log(`✅ MassMechanic Server running on port ${PORT}`);
});

// Initialize WebSocket Server
const wss = new WebSocketServer({ noServer: true });

// Handle Upgrade Request
server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// WebSocket Connection Logic
wss.on("connection", (ws) => {
  console.log("🔗 Voice Stream Connected");

  // State
  let streamSid = null;
  let deepgramLive = null;

  // --- 1. Setup Deepgram ---
  // Note: Using standard Deepgram WebSocket connection logic
  const setupDeepgram = () => {
    const deepgramUrl = "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&model=nova-2&smart_format=true";
    deepgramLive = new WebSocket(deepgramUrl, {
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
    });

    deepgramLive.on("open", () => console.log("🟢 Deepgram Connected"));
    
    deepgramLive.on("message", (data) => {
      const received = JSON.parse(data);
      const transcript = received.channel?.alternatives[0]?.transcript;
      if (transcript && received.is_final) {
        console.log(`🗣️ User said: ${transcript}`);
        handleVoiceInput(transcript);
      }
    });

    deepgramLive.on("close", () => console.log("🔴 Deepgram Closed"));
    deepgramLive.on("error", (err) => console.error("Deepgram Error:", err));
  };

  setupDeepgram();

  // --- 2. Handle Audio from Twilio ---
  ws.on("message", (message) => {
    const msg = JSON.parse(message);
    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      console.log(`📞 Stream Started: ${streamSid}`);
    } else if (msg.event === "media") {
      if (deepgramLive && deepgramLive.readyState === WebSocket.OPEN) {
        const audioBuffer = Buffer.from(msg.media.payload, "base64");
        deepgramLive.send(audioBuffer);
      }
    } else if (msg.event === "stop") {
      console.log(`📞 Stream Stopped: ${streamSid}`);
      if (deepgramLive) deepgramLive.close();
    }
  });

  // --- 3. Process Voice Input (The "Brain") ---
  async function handleVoiceInput(text) {
    if (!text || text.trim().length < 2) return;

    // Define Voice Persona
    const voiceSystemPrompt = `
      You are the Voice Assistant for Mass Mechanic.
      - Keep answers VERY short (1-2 sentences max).
      - Goal: Get the Caller's Name and Issue.
      - If they have a car problem, ask for their Zip Code.
      - Be friendly and professional.
    `;

    try {
      // Ask OpenAI
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            { role: "system", content: voiceSystemPrompt },
            { role: "user", content: text },
          ],
          max_tokens: 100,
        }),
      });

      const data = await response.json();
      const aiReply = data.choices[0].message.content;
      console.log(`🤖 AI Reply: ${aiReply}`);

      // Convert Text to Speech (Using OpenAI TTS for simplicity/quality)
      // Note: You can swap this for Deepgram TTS or ElevenLabs if preferred
      await speakResponse(aiReply);

    } catch (err) {
      console.error("AI Error:", err);
    }
  }

  // --- 4. Text to Speech & Playback ---
  async function speakResponse(text) {
    try {
      const ttsResponse = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1",
          input: text,
          voice: "alloy", // or 'shimmer', 'echo', etc.
          response_format: "wav", // Twilio expects streaming, but for simplicity we convert buffer
        }),
      });

      const arrayBuffer = await ttsResponse.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      // Convert to mulaw 8000Hz for Twilio (Requires ffmpeg logic usually)
      // For this "Emergency Restore", we will just log. 
      // NOTE: In a production stream, you need the ffmpeg/child_process logic to convert MP3/WAV -> mulaw.
      // Assuming you had that logic:
      
      // *Simpler fallback for now:* Send a text message if audio pipeline is complex to restore blindly.
      // But let's try to send a TwiML "Say" command via REST API to interrupt and speak? 
      // No, WebSocket is active. We need to send 'media' events back.
      
      // Since I cannot restore your exact ffmpeg pipeline blindly, 
      // I strongly recommend ensuring you have your 'ffmpeg' imports working or using a TTS provider that outputs mulaw directly (Deepgram TTS does this).
      
      // If you use Deepgram TTS (Simpler for Twilio):
      /*
      const deepgramTTS = await fetch(`https://api.deepgram.com/v1/speak?model=aura-asteria-en`, {
         method: 'POST',
         headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
         body: JSON.stringify({ text })
      });
      // Stream that back...
      */

    } catch (e) {
      console.error("TTS Error:", e);
    }
  }
});

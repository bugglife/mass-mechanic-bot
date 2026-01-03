import express from "express";
import fetch from "node-fetch";
import WebSocket, { WebSocketServer } from "ws";
import { spawn } from "child_process";
import ffmpegBin from "@ffmpeg-installer/ffmpeg";
import twilio from "twilio"; 
import { createClient } from "@supabase/supabase-js"; 

// ───────────────────────────────────────────────────────────────────────────────
// 1. CONFIGURATION
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 10000;

// <--- CHANGED: Allow JSON bodies (from Supabase) AND Form data (legacy/backup)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY; 
const DG_KEY = process.env.DEEPGRAM_API_KEY;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER; 
const MY_PHONE = process.env.MY_PHONE_NUMBER;         

// Supabase Keys
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; 

if (!OPENAI_API_KEY || !DG_KEY || !TWILIO_SID || !TWILIO_AUTH || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Missing API Keys. Check your .env file.");
  process.exit(1);
}

const twilioClient = twilio(TWILIO_SID, TWILIO_AUTH);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ───────────────────────────────────────────────────────────────────────────────
// 2. LEAD DISPATCH LOGIC (Helper)
// ───────────────────────────────────────────────────────────────────────────────
async function extractAndDispatchLead(history, userPhone) {
    console.log("🧠 Processing Lead for Dispatch...");

    const extractionPrompt = `
    Analyze this SMS conversation and extract the lead details into JSON.
    FIELDS: name, car_year, car_make_model, zip_code, description, service_type, drivable (Yes/No), urgency_window.
    RULES: If 'drivable' implies towing (wont start), set 'No'. Default urgency to 'Flexible'.
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
        
        console.log("📝 Extracted:", leadDetails);

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

        // Call your existing Edge Function
        await supabase.functions.invoke('send-lead-to-mechanics', {
            body: { lead_id: insertedLead.id }
        });
        console.log("🚀 Edge Function Triggered.");

    } catch (e) {
        console.error("❌ Dispatch Failed:", e);
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// 3. SMS ROUTER (UPDATED FOR SUPABASE HANDOFF)
// ───────────────────────────────────────────────────────────────────────────────
app.post('/sms', async (req, res) => {
    // <--- CHANGED: Accept input from Supabase JSON OR Twilio Form
    const incomingMsg = req.body.body || req.body.Body; 
    const fromNumber = req.body.from || req.body.From;
    
    console.log(`📩 SMS Payload from Router (${fromNumber}): ${incomingMsg}`);

    // Send 200 OK immediately so Supabase/Twilio doesn't time out
    res.status(200).send("OK");

    if (!incomingMsg || !fromNumber) return;

    const systemPrompt = `
    You are the Senior Service Advisor for Mass Mechanic.
    GOAL: Qualify this lead. Gather: Name, Car, Zip, Issue, Drivability, Urgency.
    RULES: Ask one by one. Once you have ALL items, say: "Perfect. I have sent your request to our network."
    `;

    try {
        // Retrieve History
        const { data: history } = await supabase
            .from('sms_chat_history')
            .select('role, content')
            .eq('phone', fromNumber)
            .order('created_at', { ascending: true }) 
            .limit(10);

        const pastMessages = (history || []).map(msg => ({ role: msg.role, content: msg.content }));
        
        const messagesToSend = [
            { role: "system", content: systemPrompt },
            ...pastMessages,
            { role: "user", content: incomingMsg }
        ];

        // Ask OpenAI
        const gptResponse = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "gpt-4o", messages: messagesToSend, max_tokens: 200 })
        });

        const data = await gptResponse.json();
        const replyText = data.choices[0].message.content;

        // Save Conversation
        await supabase.from('sms_chat_history').insert([
            { phone: fromNumber, role: 'user', content: incomingMsg },
            { phone: fromNumber, role: 'assistant', content: replyText }
        ]);

        // <--- CHANGED: Send Reply Manually (No TwiML)
        await twilioClient.messages.create({
            body: replyText,
            from: TWILIO_PHONE,
            to: fromNumber
        });
        console.log(`📤 SMS Reply Sent via API: ${replyText}`);

        // Check if finished -> Dispatch
        if (replyText.includes("sent your request")) {
            extractAndDispatchLead([...pastMessages, { role: "user", content: incomingMsg }, { role: "assistant", content: replyText }], fromNumber);
        }

    } catch (error) {
        console.error("❌ SMS Error:", error);
    }
});

// ───────────────────────────────────────────────────────────────────────────────
// 4. VOICE SERVER (UNCHANGED)
// ───────────────────────────────────────────────────────────────────────────────
class ConversationContext {
  constructor() {
    this.state = "greeting"; 
    this.data = { name: null, zip: "Not Provided", phone: "", userType: "driver" };
  }
}
// ... (Voice logic remains here) ...

const server = app.listen(PORT, () => console.log(`MassMechanic Server on ${PORT}`));

// WebSockets for Voice
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
// ... (WSS Connection logic) ...

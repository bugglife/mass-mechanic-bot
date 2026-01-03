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

// SUPPORT BOTH JSON (Supabase) AND URL-ENCODED (Twilio Legacy)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// ... existing imports ...
const app = express();
// ... existing app.use ...

// --- ADD THIS HEALTH CHECK ROUTE ---
app.get('/', (req, res) => {
    res.send("Mass Mechanic Server is Awake 🤖");
});

// ... rest of your code ...

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
// 2. INTELLIGENT LEAD DISPATCHER
// ───────────────────────────────────────────────────────────────────────────────
async function extractAndDispatchLead(history, userPhone) {
    console.log("🧠 Processing Lead for Dispatch...");

    // Prompt maps to QuoteForm fields
    const extractionPrompt = `
    Analyze this SMS conversation and extract the lead details into JSON.
    
    FIELDS TO EXTRACT:
    - name: (String)
    - car_year: (String, e.g. "2015")
    - car_make_model: (String, e.g. "Honda Civic")
    - zip_code: (String, 5 digits)
    - description: (String, the core issue)
    
    CRITICAL SCORING FIELDS:
    - service_type: (Map to ONE: 'oil-change', 'state-inspection', 'tune-up', 'tire-rotation', 'no-start', 'brake-repair', 'check-engine-light', 'suspension-repair', 'exhaust-repair', 'battery-replacement', 'overheating', 'other')
    - drivable: (Map to ONE: 'Yes', 'No', 'Not sure')
    - urgency_window: (Map to ONE: 'Today', '1-2 days', 'This week', 'Flexible')

    RULES: 
    - If 'drivable' implies towing (wont start, stuck, wheel fell off), set 'No'. 
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

        // 2. ROUTING LOGIC (Maintenance vs Repair)
        //
        const maintenanceServices = ['oil-change', 'state-inspection', 'tune-up', 'tire-rotation'];
        const isMaintenance = maintenanceServices.includes(leadDetails.service_type);

        if (isMaintenance) {
            console.log("🔧 Detected Maintenance Lead. Routing to Subscription Pool...");
            // Route to: send-maintenance-lead-to-mechanics
            await supabase.functions.invoke('send-maintenance-lead-to-mechanics', {
                body: { lead_id: insertedLead.id }
            });
        } else {
            console.log("🚨 Detected Repair Lead. Routing to Urgent Blast...");
            // Route to: send-lead-to-mechanics
            await supabase.functions.invoke('send-lead-to-mechanics', {
                body: { lead_id: insertedLead.id }
            });
        }

        console.log("🚀 Dispatch Complete.");

    } catch (e) {
        console.error("❌ Dispatch Failed:", e);
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// 3. SMS ROUTER (Worker Node)
// ───────────────────────────────────────────────────────────────────────────────
app.post('/sms', async (req, res) => {
    // Input Handling (JSON from Supabase, or Form from Twilio Fallback)
    const incomingMsg = req.body.body || req.body.Body; 
    const fromNumber = req.body.from || req.body.From;
    
    // Acknowledge immediately (200 OK)
    res.status(200).send("OK");

    if (!incomingMsg || !fromNumber) return;

    console.log(`📩 SMS from ${fromNumber}: ${incomingMsg}`);

    // System Prompt (Service Advisor Persona)
    const systemPrompt = `
    You are the Senior Service Advisor for Mass Mechanic.
    
    GOAL: Qualify this lead. We need specific details to score the lead.
    
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
            from: TWILIO_PHONE,
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
// 4. VOICE SERVER (Unchanged)
// ───────────────────────────────────────────────────────────────────────────────
class ConversationContext {
  constructor() {
    this.state = "greeting"; 
    this.data = { name: null, zip: "Not Provided", phone: "", userType: "driver" };
  }
}
// ... (Voice logic remains here) ...

const server = app.listen(PORT, () => console.log(`MassMechanic Server on ${PORT}`));

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  console.log("🔗 Voice Call Connected");
  // ... (WebSocket logic) ...
});

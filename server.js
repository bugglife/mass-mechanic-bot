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

// Middleware to parse incoming Twilio SMS data
app.use(express.urlencoded({ extended: true }));

// API Keys
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; 
const DG_KEY = process.env.DEEPGRAM_API_KEY;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER; 
const MY_PHONE = process.env.MY_PHONE_NUMBER;         

// Supabase Keys
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // Use the SERVICE_ROLE (Secret) key!

if (!OPENAI_API_KEY || !DG_KEY || !TWILIO_SID || !TWILIO_AUTH || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Missing API Keys. Check your .env file.");
  process.exit(1);
}

// Initialize Clients
const twilioClient = twilio(TWILIO_SID, TWILIO_AUTH);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ───────────────────────────────────────────────────────────────────────────────
// 2. NEW: SMS AUTO-REPLY BOT
// ───────────────────────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────────────
// NEW: SMS AUTO-REPLY BOT (WITH MEMORY)
// ───────────────────────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────────────
// NEW: SMS AUTO-REPLY BOT (WITH MEMORY)
// ───────────────────────────────────────────────────────────────────────────────
app.post('/sms', async (req, res) => {
    const incomingMsg = req.body.Body;
    const fromNumber = req.body.From;
    
    console.log(`📩 SMS Received from ${fromNumber}: ${incomingMsg}`);

    // 1. Define the Bot's Personality
    const systemPrompt = `
    You are the SMS assistant for Mass Mechanic.
    - We are a referral service, NOT a repair shop.
    - We connect drivers with trusted local mechanics in Massachusetts for free quotes.
    - Our service is 100% free for drivers.
    - GOAL: Get their Zip Code and Car Make/Model.
    - Once you have both Zip and Car, tell them: "Thanks! I have sent your request to a local shop. They will text you shortly with a quote."
    - Keep answers short (under 160 chars) and friendly.
    `;

    try {
        // 2. RETRIEVE HISTORY (The Memory Fix)
        const { data: history } = await supabase
            .from('sms_chat_history')
            .select('role, content')
            .eq('phone', fromNumber)
            .order('created_at', { ascending: true }) 
            .limit(6); // Remember last 6 texts

        // 3. CONSTRUCT CONVERSATION FOR AI
        // We map the DB history to OpenAI format
        const pastMessages = (history || []).map(msg => ({ role: msg.role, content: msg.content }));
        
        const messagesToSend = [
            { role: "system", content: systemPrompt },
            ...pastMessages,
            { role: "user", content: incomingMsg }
        ];

        // 4. ASK OPENAI
        const gptResponse = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENAI_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "gpt-4o", 
                messages: messagesToSend,
                max_tokens: 150
            })
        });

        const data = await gptResponse.json();
        const replyText = data.choices[0].message.content;

        // 5. SAVE NEW CONVERSATION TO DB
        await supabase.from('sms_chat_history').insert([
            { phone: fromNumber, role: 'user', content: incomingMsg },
            { phone: fromNumber, role: 'assistant', content: replyText }
        ]);

        // 6. SEND REPLY TO TWILIO
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(replyText);

        res.type('text/xml').send(twiml.toString());
        console.log(`📤 SMS Reply Sent: ${replyText}`);

    } catch (error) {
        console.error("❌ SMS Error:", error);
        res.status(500).send("Error");
    }
});
// ───────────────────────────────────────────────────────────────────────────────
// 3. VOICE CONVERSATION BRAIN
// ───────────────────────────────────────────────────────────────────────────────
class ConversationContext {
  constructor() {
    this.state = "greeting"; 
    this.data = {
      name: null,
      zip: "Not Provided", 
      phone: "",       
      callerId: "",
      makeModel: "Not Provided", 
      issue: "Not Provided",     
      message: "",
      manualContact: "", 
      userType: "driver"
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 4. UTILITIES (Database & SMS)
// ───────────────────────────────────────────────────────────────────────────────

function sendSms(to, body) {
    twilioClient.messages.create({
        body: body,
        from: TWILIO_PHONE,
        to: to
    }).then(msg => console.log(`✅ SMS sent to ${to}`))
      .catch(err => console.error(`❌ SMS Failed: ${err.message}`));
}

async function saveToSupabase(data) {
    try {
        const bestPhone = data.phone || data.manualContact || data.callerId || "Unknown";
        const { error } = await supabase
            .from('phone_leads') 
            .insert({
                phone: bestPhone,
                zip: data.zip,
                make_model: data.makeModel,
                issue: data.issue,
                message: data.message,
                user_type: data.userType
            });
        if (error) throw error;
        console.log("🚀 Data saved to Supabase (phone_leads)!");
    } catch (err) {
        console.error("❌ Supabase Insert Failed:", err.message);
    }
}

function generateReport(data) {
    let report = "";
    if (data.userType === "manager_request") {
        const contact = data.manualContact || data.callerId || "Unknown";
        report = `🚨 MANAGER REQUEST\nFrom: ${contact}\n\nMessage:\n"${data.message.trim()}"`;
    } else {
        const contact = data.phone || data.callerId || "Unknown";
        report = `🚗 NEW LEAD\nZip: ${data.zip}\nCar: ${data.makeModel}\nIssue: ${data.issue}\nPhone: ${contact}`;
    }
    return report;
}

const NUMBER_WORDS_MAP = { 'zero': '0', 'oh': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9' };
const TENS_MAP = { 'twenty': '2', 'thirty': '3', 'forty': '4', 'fifty': '5', 'sixty': '6', 'seventy': '7', 'eighty': '8', 'ninety': '9' };

function extractPhoneNumber(text) {
  const q = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
  let digits = '';
  const words = q.split(/\s+/);
  
  const match = q.match(/(\d{3})[\s.-]?(\d{3})[\s.-]?(\d{4})/);
  if (match) return match[0].replace(/\D/g, '');

  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (word === 'hundred') { digits += "00"; i++; continue; }
    if (TENS_MAP[word]) {
       const firstDigit = TENS_MAP[word];
       if (i + 1 < words.length && NUMBER_WORDS_MAP[words[i+1]] && NUMBER_WORDS_MAP[words[i+1]].length === 1) {
           digits += firstDigit + NUMBER_WORDS_MAP[words[i+1]]; i += 2; continue;
       } else { digits += firstDigit + '0'; i++; continue; }
    }
    if (NUMBER_WORDS_MAP[word] && NUMBER_WORDS_MAP[word].length === 1) { digits += NUMBER_WORDS_MAP[word]; } 
    else if (/^\d+$/.test(word)) { digits += word; }
    i++;
  }
  return digits.length > 0 ? digits : null;
}

// ───────────────────────────────────────────────────────────────────────────────
// 5. INTELLIGENCE (Voice Routing)
// ───────────────────────────────────────────────────────────────────────────────
function routeIntent(text, ctx) {
  const q = text.toLowerCase();

  // ─── MANAGER FLOW ───
  if (q.includes("manager") || q.includes("operator") || q.includes("supervisor") || q.includes("owner") || q.includes("speak with") || q.includes("talk to a person")) {
      ctx.state = "confirm_manager";
      return "Would you like me to connect you with a member of our team?";
  }

  if (ctx.state === "confirm_manager") {
      if (q.includes("yes") || q.includes("sure") || q.includes("please")) {
          ctx.state = "collect_contact_info"; 
          ctx.data.userType = "manager_request"; 
          return "Okay. First, what is your name and the best phone number to reach you at?";
      }
      ctx.state = "greeting";
      return "Okay, no problem. I can help you find a mechanic or answer general questions. How can I help?";
  }
  
  // ─── BOOKING FLOW ───
  if (ctx.state === "confirm_phone") {
      if (q.includes("no") || q.includes("wrong")) {
          ctx.data.phone = "";
          ctx.state = "collect_phone";
          return "No problem. Let's try again. What is your phone number?";
      }
      if (q.includes("yes") || q.includes("correct") || q.includes("right")) {
          ctx.state = "closing";
          return "Perfect. I've sent your request to our network. A verified local shop will contact you shortly with a quote. Thanks for choosing Mass Mechanic! Bye now.";
      }
      return `Just want to be sure. Is it ${ctx.data.phone}?`;
  }

  if (ctx.state === "collect_phone") {
    const extracted = extractPhoneNumber(text);
    if (extracted && (ctx.data.phone.length > 0 || extracted.length >= 3)) ctx.data.phone += extracted;
    
    const len = ctx.data.phone.length;
    if (len >= 10) {
      ctx.state = "confirm_phone"; 
      return `Okay, I have ${ctx.data.phone}. Is that correct?`;
    }
    if (len > 0) return `I have ${len} digits so far. What comes next?`;
    return "Okay, noted. What is the best phone number to reach you at?";
  }

  if (q.includes("mechanic") && (q.includes("looking for work") || q.includes("partner"))) {
      ctx.data.userType = "mechanic";
      return "That's great! We are looking for partners. Please visit mass mechanic dot com and click 'Partner With Us'.";
  }

  if (ctx.state === "greeting") {
    if (q.includes("book") || q.includes("schedule") || q.includes("repair") || q.includes("yes") || q.includes("sure")) {
      ctx.state = "collect_zip";
      return "Great. I can help with that. To find the closest shops to you, what is your Zip Code?";
    }
    return "Are you looking to find a mechanic for a repair, or do you have questions about how we work?";
  }

  if (ctx.state === "collect_zip") {
      const zipMatch = text.match(/\b\d{5}\b/);
      if (zipMatch) {
          ctx.data.zip = zipMatch[0];
          ctx.state = "collect_details";
          return "Thanks. And what is the Year, Make, and Model of your car?";
      }
      if (text.length > 3) {
          ctx.data.zip = text; 
          ctx.state = "collect_details";
          return "Got it. What is the Year, Make, and Model of the vehicle?";
      }
      return "I need a Zip Code or City to find mechanics near you. Where are you located?";
  }

  if (ctx.state === "collect_details") {
    if (text.length < 10 && (q.includes("i have") || q.includes("it is"))) return null; 
    
    const isJustYear = text.match(/^(19|20)\d{2}$/) || text.match(/^(nineteen|twenty)/i);
    if (isJustYear && text.split(" ").length < 4) {
         ctx.data.makeModel = text; 
         return `Okay, ${text}. And what is the Make and Model?`;
    }
    if (ctx.data.makeModel !== "Not Provided") ctx.data.makeModel += " " + text;
    else ctx.data.makeModel = text;

    ctx.state = "collect_issue";
    return "Okay, got it. And can you tell me a little bit about what's going on with it?";
  }

  if (ctx.state === "collect_issue") {
    ctx.data.issue = text;
    ctx.state = "collect_phone";
    if (text.split(" ").length < 4) return "Understood. I can match you with a shop for that. What's the best phone number to reach you at?";
    return "Oof, I hear you. That sounds frustrating. I want to match you with a mechanic who can fix that. What's the best phone number for them to contact you?";
  }

  return "Could you repeat that?";
}

// ───────────────────────────────────────────────────────────────────────────────
// 6. AUDIO PIPELINE
// ───────────────────────────────────────────────────────────────────────────────
async function ttsToMulaw(text) { 
  const url = "https://api.openai.com/v1/audio/speech";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "tts-1", voice: "shimmer", input: text, response_format: "pcm" }),
  });
  if (!res.ok) throw new Error(`OpenAI Error: ${res.statusText}`);
  const inputBuffer = Buffer.from(await res.arrayBuffer());
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegBin.path, ["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0", "-f", "mulaw", "-ar", "8000", "-ac", "1", "pipe:1"]);
    const chunks = [];
    ff.stdout.on("data", c => chunks.push(c));
    ff.on("close", () => resolve(Buffer.concat(chunks)));
    ff.on("error", reject);
    ff.stdin.end(inputBuffer);
  });
}

async function speakResponse(ws, text) {
    ws._speaking = true;
    const myMsgId = ++ws._currentMsgId;
    console.log(`Bot: ${text}`);
    try {
        const audio = await ttsToMulaw(text);
        if (ws._currentMsgId !== myMsgId) return; 
        const FRAME_SIZE = 160; 
        for (let i = 0; i < audio.length; i += FRAME_SIZE) {
            if (ws._currentMsgId !== myMsgId || ws.readyState !== ws.OPEN) break;
            const frame = audio.slice(i, i + FRAME_SIZE).toString("base64");
            ws.send(JSON.stringify({ event: "media", streamSid: ws._streamSid, media: { payload: frame } }));
            await new Promise(r => setTimeout(r, 20));
        }
        
        if (ws._ctx.state === "closing" && ws._currentMsgId === myMsgId) {
           const report = generateReport(ws._ctx.data);
           if (MY_PHONE) sendSms(MY_PHONE, report);
           saveToSupabase(ws._ctx.data);
           setTimeout(() => { if (ws._currentMsgId === myMsgId) ws.close(); }, 3000);
        }
    } catch (e) { console.error(e); } 
    finally { if (ws._currentMsgId === myMsgId) ws._speaking = false; }
}

// ───────────────────────────────────────────────────────────────────────────────
// 7. SERVER SETUP (WEBHOOKS + WEBSOCKETS)
// ───────────────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => console.log(`MassMechanic Server on ${PORT}`));
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  console.log("🔗 Call Connected");
  ws._ctx = new ConversationContext();
  ws._speaking = false;
  ws._currentMsgId = 0; 
  ws._messageTimer = null; 
  ws._contactTimer = null;

  const dg = new WebSocket(`wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&endpointing=true`, {
    headers: { Authorization: `Token ${DG_KEY}` }
  });

  dg.on("message", async (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.is_final && msg.channel?.alternatives?.[0]?.transcript) {
      const transcript = msg.channel.alternatives[0].transcript;
      if (!transcript.trim()) return;
      console.log(`User: ${transcript}`);

      if (ws._ctx.state === "closing") return; 

      if (ws._ctx.state === "collect_contact_info") {
          ws._ctx.data.manualContact += " " + transcript;
          console.log(`📝 Contact Buffer: "${ws._ctx.data.manualContact.trim()}"`);
          if (ws._contactTimer) clearTimeout(ws._contactTimer);
          ws._contactTimer = setTimeout(() => {
              ws._ctx.state = "take_message";
              const reply = "Thanks. Go ahead with your message, and I'll text it to them immediately.";
              speakResponse(ws, reply);
          }, 3000); 
          return;
      }
      
      if (ws._ctx.state === "take_message") {
          ws._ctx.data.message += " " + transcript;
          console.log(`📝 Message Buffer: "${ws._ctx.data.message.trim()}"`);
          if (ws._messageTimer) clearTimeout(ws._messageTimer);
          ws._messageTimer = setTimeout(() => {
              console.log("Message recording finished.");
              ws._ctx.state = "closing"; 
              const report = generateReport(ws._ctx.data);
              if (MY_PHONE) sendSms(MY_PHONE, report);
              saveToSupabase(ws._ctx.data);
              const reply = "Thanks. I've sent that text to them immediately. They should get back to you soon. Thanks for calling Mass Mechanic! Bye now.";
              speakResponse(ws, reply);
          }, 6000); 
          return; 
      }
      
      if (ws._speaking) {
         console.log("!! Barge-in: Clearing audio !!");
         ws.send(JSON.stringify({ event: "clear", streamSid: ws._streamSid }));
      }
      
      const reply = routeIntent(transcript, ws._ctx);
      if (!reply) return; 
      speakResponse(ws, reply);
    }
  });

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);
    if (data.event === "start") {
      ws._streamSid = data.start.streamSid;
      console.log("Call Started");
      
      if (data.start.customParameters && data.start.customParameters.callerNumber) {
          ws._ctx.data.callerId = data.start.customParameters.callerNumber;
          console.log("📞 Caller ID Captured:", ws._ctx.data.callerId);
      }

      const greeting = "Hi! Thanks for calling Mass Mechanic. I can connect you with a trusted local mechanic for a free quote. Are you looking to schedule a repair, or do you have general questions?";
      speakResponse(ws, greeting);
    }
    if (data.event === "media" && dg.readyState === dg.OPEN) {
      const payload = Buffer.from(data.media.payload, "base64");
      dg.send(payload);
    }
    if (data.event === "stop") dg.close();
  });

  ws.on("close", () => {
     console.log("🔴 Call Ended");
     console.log("📝 FINAL CAPTURE DATA:");
     console.log(JSON.stringify(ws._ctx.data, null, 2));
  });
});

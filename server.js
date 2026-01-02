import express from "express";
import fetch from "node-fetch";
import WebSocket, { WebSocketServer } from "ws";
import { spawn } from "child_process";
import ffmpegBin from "@ffmpeg-installer/ffmpeg";
import twilio from "twilio"; 

// ───────────────────────────────────────────────────────────────────────────────
// 1. CONFIGURATION
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 10000;

// API Keys
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; 
const DG_KEY = process.env.DEEPGRAM_API_KEY;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER; 
const MY_PHONE = process.env.MY_PHONE_NUMBER;         

if (!OPENAI_API_KEY || !DG_KEY || !TWILIO_SID || !TWILIO_AUTH) {
  console.error("❌ Missing API Keys. Check your .env file.");
  process.exit(1);
}

const twilioClient = twilio(TWILIO_SID, TWILIO_AUTH);

// ───────────────────────────────────────────────────────────────────────────────
// 2. CONVERSATION BRAIN
// ───────────────────────────────────────────────────────────────────────────────
class ConversationContext {
  constructor() {
    this.state = "greeting"; 
    this.data = {
      name: null,
      zip: null,
      phone: "",       
      callerId: "",
      makeModel: null, 
      issue: null,     
      message: "",
      manualContact: null, // <--- NEW: Stores Name/Number they speak manually
      userType: "driver"
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 3. UTILITIES
// ───────────────────────────────────────────────────────────────────────────────
function sendSms(to, body) {
    twilioClient.messages.create({
        body: body,
        from: TWILIO_PHONE,
        to: to
    }).then(msg => console.log(`✅ SMS sent to ${to}`))
      .catch(err => console.error(`❌ SMS Failed: ${err.message}`));
}

const NUMBER_WORDS_MAP = {
  'zero': '0', 'oh': '0', 'o': '0', 'one': '1', 'won': '1',
  'two': '2', 'to': '2', 'too': '2', 'three': '3', 'tree': '3',
  'four': '4', 'for': '4', 'five': '5', 'six': '6', 'seven': '7',
  'eight': '8', 'ate': '8', 'nine': '9',
  'double': 'repeat_next', 'triple': 'triple_next'
};

const TENS_MAP = {
  'twenty': '2', 'thirty': '3', 'forty': '4', 'fifty': '5',
  'sixty': '6', 'seventy': '7', 'eighty': '8', 'ninety': '9'
};

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
    if (word === 'double' && i + 1 < words.length) {
      const nextDigit = NUMBER_WORDS_MAP[words[i + 1]];
      if (nextDigit && nextDigit.length === 1) { digits += nextDigit + nextDigit; i += 2; continue; }
    }
    if (NUMBER_WORDS_MAP[word] && NUMBER_WORDS_MAP[word].length === 1) { digits += NUMBER_WORDS_MAP[word]; } 
    else if (/^\d+$/.test(word)) { digits += word; }
    i++;
  }
  return digits.length > 0 ? digits : null;
}

// ───────────────────────────────────────────────────────────────────────────────
// 4. INTELLIGENCE (Routing Logic)
// ───────────────────────────────────────────────────────────────────────────────
function routeIntent(text, ctx) {
  const q = text.toLowerCase();

  // ─── MANAGER FLOW (UPDATED) ───
  
  // Step 1: Trigger
  if (q.includes("manager") || q.includes("operator") || q.includes("supervisor") || q.includes("owner") || q.includes("speak with") || q.includes("talk to a person") || q.includes("real person")) {
      ctx.state = "confirm_manager";
      return "Would you like me to connect you with a member of our team?";
  }

  // Step 2: Confirm -> Ask for Contact Info (NEW)
  if (ctx.state === "confirm_manager") {
      if (q.includes("yes") || q.includes("yeah") || q.includes("sure") || q.includes("please")) {
          ctx.state = "collect_contact_info"; // <--- Move to new state
          return "Okay. First, what is your name and the best phone number to reach you at?";
      }
      ctx.state = "greeting";
      return "Okay, no problem. I can help you find a mechanic or answer general questions. How can I help?";
  }

  // Step 3: Capture Name/Number -> Start Recording (NEW)
  if (ctx.state === "collect_contact_info") {
      ctx.data.manualContact = text; // Save what they said (e.g. "Tom 508-555...")
      ctx.state = "take_message";
      return "Thanks. Go ahead with your message, and I'll text it to them immediately.";
  }

  // ─── BOOKING FLOW ───
  if (ctx.state === "confirm_phone") {
      if (q.includes("no") || q.includes("wrong") || q.includes("wait")) {
          ctx.data.phone = "";
          ctx.state = "collect_phone";
          return "No problem. Let's try again. What is your phone number?";
      }
      if (q.includes("yes") || q.includes("correct") || q.includes("right") || q.includes("yeah")) {
          ctx.state = "closing";
          return "Perfect. I've sent your request to our network. A verified local shop will contact you shortly with a quote. Thanks for choosing Mass Mechanic! Bye now.";
      }
      const p = ctx.data.phone;
      const clean = p.slice(0, 10);
      const formatted = `${clean[0]} ${clean[1]} ${clean[2]}... ${clean[3]} ${clean[4]} ${clean[5]}... ${clean[6]} ${clean[7]} ${clean[8]} ${clean[9]}`;
      return `Just want to be sure. Is it ${formatted}?`;
  }

  if (ctx.state === "collect_phone") {
    const extracted = extractPhoneNumber(text);
    if (extracted && (ctx.data.phone.length > 0 || extracted.length >= 3)) ctx.data.phone += extracted;
    
    const len = ctx.data.phone.length;
    if (len >= 10) {
      ctx.state = "confirm_phone"; 
      const p = ctx.data.phone.slice(0, 10);
      const formatted = `${p[0]} ${p[1]} ${p[2]}... ${p[3]} ${p[4]} ${p[5]}... ${p[6]} ${p[7]} ${p[8]} ${p[9]}`;
      return `Okay, I have ${formatted}. Is that correct?`;
    }
    if (len > 0) return `I have ${len} digits so far. What comes next?`;
    return "Okay, noted. What is the best phone number to reach you at?";
  }

  if (q.includes("i am a mechanic") || q.includes("looking for work") || q.includes("partner")) {
      ctx.data.userType = "mechanic";
      return "That's great! We are looking for partners. Please visit mass mechanic dot com and click 'Partner With Us'.";
  }
  if (q.includes("what is mass mechanic") || q.includes("who are you")) {
    return "Mass Mechanic is a referral service. We match you with trusted local shops for free quotes. Can I help you find a mechanic today?";
  }
  if (q.includes("how much") || q.includes("price") || q.includes("cost")) {
    return "Our service is 100% free for drivers. You only pay the shop if you choose to hire them.";
  }

  if (ctx.state === "greeting") {
    if (q.includes("book") || q.includes("schedule") || q.includes("repair") || q.includes("quote") || q.includes("fix")) {
      ctx.state = "collect_zip";
      return "Great. I can help with that. To find the closest shops to you, what is your Zip Code?";
    }
    if (q.includes("question") || q.includes("info")) return "Sure, I can answer your questions. What would you like to know?";
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
    if (ctx.data.makeModel) ctx.data.makeModel += " " + text;
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

  if (ctx.state === "greeting") return "I can help you find a trusted mechanic. Are you looking to get a quote?";
  return "Could you repeat that?";
}

// ───────────────────────────────────────────────────────────────────────────────
// 5. AUDIO PIPELINE
// ───────────────────────────────────────────────────────────────────────────────
async function ttsToMulaw(text) { 
  const url = "https://api.openai.com/v1/audio/speech";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
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
           setTimeout(() => { if (ws._currentMsgId === myMsgId) ws.close(); }, 3000);
        }
    } catch (e) { console.error(e); } 
    finally { if (ws._currentMsgId === myMsgId) ws._speaking = false; }
}

// ───────────────────────────────────────────────────────────────────────────────
// 6. SERVER SETUP
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 Call Connected");
  ws._ctx = new ConversationContext();
  ws._speaking = false;
  ws._currentMsgId = 0; 
  ws._messageTimer = null; 

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
      
      // ─── VOICEMAIL LOGIC ───
      if (ws._ctx.state === "take_message") {
          ws._ctx.data.message += " " + transcript;
          console.log(`📝 Buffer: "${ws._ctx.data.message.trim()}"`);

          if (ws._messageTimer) clearTimeout(ws._messageTimer);
          
          ws._messageTimer = setTimeout(() => {
              console.log("Message recording finished.");
              ws._ctx.state = "closing"; 
              
              // <--- SMS CONSTRUCTION (Using the manually given contact info)
              const who = ws._ctx.data.manualContact || ws._ctx.data.callerId || "Unknown";
              const note = `📞 Voicemail from:\n${who}\n\nMessage:\n"${ws._ctx.data.message.trim()}"`;
              
              if (MY_PHONE) sendSms(MY_PHONE, note);

              // Don't send confirmation to the user here because 'manualContact' might contain words like "It's Tom" which isn't a valid phone number.
              
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

const server = app.listen(PORT, () => console.log(`MassMechanic Server on ${PORT}`));

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

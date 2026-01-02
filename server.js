import express from "express";
import fetch from "node-fetch";
import WebSocket, { WebSocketServer } from "ws";
import { spawn } from "child_process";
import ffmpegBin from "@ffmpeg-installer/ffmpeg";

// ───────────────────────────────────────────────────────────────────────────────
// 1. CONFIGURATION
// ───────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 10000;

// API Keys - Ensure these are in your .env file
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; 
const DG_KEY = process.env.DEEPGRAM_API_KEY;

// Audio Configuration
const MEDIA_FORMAT = "pcm16"; // Keep this simple for now
const SAMPLE_RATE = 8000; // Phone standard

if (!OPENAI_API_KEY || !DG_KEY) {
  console.error("❌ Missing API Keys. Check your .env file.");
  process.exit(1);
}

// ───────────────────────────────────────────────────────────────────────────────
// 2. CONVERSATION BRAIN (The "State Machine")
// ───────────────────────────────────────────────────────────────────────────────
class ConversationContext {
  constructor() {
    this.state = "greeting"; // Initial state
    this.data = {
      name: null,
      phone: "",       // To store the caller's number
      makeModel: null, // e.g., "Ford F-150"
      issue: null,     // e.g., "Brakes squeaking"
      appointment: null
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 3. UTILITIES (Phone Number Extraction)
// ───────────────────────────────────────────────────────────────────────────────
// This is the "Smart" number extractor from File 2
const NUMBER_WORDS_MAP = {
  'zero': '0', 'oh': '0', 'o': '0', 'one': '1', 'won': '1',
  'two': '2', 'to': '2', 'too': '2', 'three': '3', 'tree': '3',
  'four': '4', 'for': '4', 'five': '5', 'six': '6', 'seven': '7',
  'eight': '8', 'ate': '8', 'nine': '9',
  'double': 'repeat_next', 'triple': 'triple_next'
};

function extractPhoneNumber(text) {
  const q = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
  let digits = '';
  const words = q.split(/\s+/);
  
  // Basic regex check first
  const match = q.match(/(\d{3})[\s.-]?(\d{3})[\s.-]?(\d{4})/);
  if (match) return match[0].replace(/\D/g, '');

  let i = 0;
  while (i < words.length) {
    const word = words[i];
    
    // Handle "double 5" -> 55
    if (word === 'double' && i + 1 < words.length) {
      const nextDigit = NUMBER_WORDS_MAP[words[i + 1]];
      if (nextDigit && nextDigit.length === 1) {
        digits += nextDigit + nextDigit;
        i += 2; continue;
      }
    }
    
    if (NUMBER_WORDS_MAP[word] && NUMBER_WORDS_MAP[word].length === 1) {
      digits += NUMBER_WORDS_MAP[word];
    } else if (/^\d+$/.test(word)) {
      digits += word;
    }
    i++;
  }
  return digits.length > 0 ? digits : null;
}

// ───────────────────────────────────────────────────────────────────────────────
// 4. INTELLIGENCE (Routing Logic)
// ───────────────────────────────────────────────────────────────────────────────
function routeIntent(text, ctx) {
  const q = text.toLowerCase();

  // 1. Phone Collection State (Priority)
  if (ctx.state === "collect_phone") {
    const extracted = extractPhoneNumber(text);
    if (extracted) {
      // Logic to accumulate digits if they pause
      ctx.data.phone += extracted;
      
      if (ctx.data.phone.length >= 10) {
        ctx.state = "closing";
        return `Got it. I have ${ctx.data.phone.split('').join(' ')}. A mechanic will call you back shortly. Thanks for calling Mass Mechanic!`;
      } else {
        return `I have ${ctx.data.phone.length} digits so far. What are the last ${10 - ctx.data.phone.length}?`;
      }
    }
    // Fallback if they didn't say numbers
    return "I didn't catch that number. Could you say the digits one at a time?";
  }

  // 2. Greeting / General Questions
  if (ctx.state === "greeting") {
    if (q.includes("book") || q.includes("appointment") || q.includes("schedule") || q.includes("broken")) {
      ctx.state = "collect_details";
      return "I can help with that. What is the Year, Make, and Model of your vehicle?";
    }
    if (q.includes("hour") || q.includes("open")) {
      return "Mass Mechanic is open 8 AM to 6 PM, Monday through Friday.";
    }
  }

  // 3. Vehicle Details
  if (ctx.state === "collect_details") {
    ctx.data.makeModel = text; // Save whatever they said
    ctx.state = "collect_issue";
    return "Okay. And what seems to be the problem with the vehicle?";
  }

  // 4. Issue Details -> Move to Phone
  if (ctx.state === "collect_issue") {
    ctx.data.issue = text;
    ctx.state = "collect_phone";
    return "Understood. I'd like to have a mechanic look at this request. What is the best phone number to reach you at?";
  }

  // Default Fallback
  return "I can help you schedule a repair. What kind of car do you have?";
}

// ───────────────────────────────────────────────────────────────────────────────
// 5. AUDIO PIPELINE (OpenAI TTS + FFmpeg)
// ───────────────────────────────────────────────────────────────────────────────
async function ttsToPcm16(text) {
  const url = "https://api.openai.com/v1/audio/speech";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ 
      model: "tts-1", 
      voice: "onyx", // "onyx" is a good, deep male voice for a mechanic shop
      input: text, 
      response_format: "pcm" 
    }),
  });

  if (!res.ok) throw new Error(`OpenAI Error: ${res.statusText}`);
  const inputBuffer = Buffer.from(await res.arrayBuffer());

  // Convert 24k -> 8k using FFmpeg
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegBin.path, [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0", // Input
      "-f", "s16le", "-ar", "8000", "-ac", "1", "pipe:1"         // Output
    ]);
    const chunks = [];
    ff.stdout.on("data", c => chunks.push(c));
    ff.on("close", () => resolve(Buffer.concat(chunks)));
    ff.on("error", reject);
    ff.stdin.end(inputBuffer);
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// 6. SERVER SETUP (WebSocket + Deepgram)
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 Call Connected");
  ws._ctx = new ConversationContext(); // Give this call a "brain"
  ws._speaking = false;

  // Setup Deepgram STT
  const dg = new WebSocket(`wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=8000&channels=1&endpointing=true`, {
    headers: { Authorization: `Token ${DG_KEY}` }
  });

  dg.on("message", async (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.is_final && msg.channel?.alternatives?.[0]?.transcript) {
      const transcript = msg.channel.alternatives[0].transcript;
      if (!transcript.trim()) return;
      
      console.log(`User: ${transcript}`);
      
      // Prevent bot from talking over itself
      if (ws._speaking) return; 

      const reply = routeIntent(transcript, ws._ctx);
      console.log(`Bot: ${reply}`);

      // Stream Audio Back
      ws._speaking = true;
      try {
        const audio = await ttsToPcm16(reply);
        
        // Send to Twilio in 20ms chunks
        const FRAME_SIZE = 320; // 20ms @ 8khz
        for (let i = 0; i < audio.length; i += FRAME_SIZE) {
          if (ws.readyState !== ws.OPEN) break;
          const frame = audio.slice(i, i + FRAME_SIZE).toString("base64");
          ws.send(JSON.stringify({ 
            event: "media", 
            streamSid: ws._streamSid, 
            media: { payload: frame } 
          }));
          await new Promise(r => setTimeout(r, 20));
        }
      } catch (e) {
        console.error(e);
      } finally {
        ws._speaking = false;
      }
    }
  });

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);
    if (data.event === "start") {
      ws._streamSid = data.start.streamSid;
      console.log("Call Started. Stream SID:", ws._streamSid);
      
      // Initial Greeting
      const greeting = "Thanks for calling Mass Mechanic. I can help you schedule a repair or answer questions. How can I help?";
      
      // Reuse the TTS logic for greeting
      (async () => {
         ws._speaking = true;
         const audio = await ttsToPcm16(greeting);
         const FRAME_SIZE = 320;
         for (let i = 0; i < audio.length; i += FRAME_SIZE) {
           if (ws.readyState !== ws.OPEN) break;
           ws.send(JSON.stringify({ 
             event: "media", streamSid: ws._streamSid, media: { payload: audio.slice(i, i + FRAME_SIZE).toString("base64") } 
           }));
           await new Promise(r => setTimeout(r, 20));
         }
         ws._speaking = false;
      })();
    }
    if (data.event === "media" && dg.readyState === dg.OPEN) {
      // Send audio from phone to Deepgram
      const payload = Buffer.from(data.media.payload, "base64");
      dg.send(payload);
    }
    if (data.event === "stop") dg.close();
  });
});

const server = app.listen(PORT, () => console.log(`MassMechanic Server on ${PORT}`));

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

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

// API Keys
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; 
const DG_KEY = process.env.DEEPGRAM_API_KEY;

if (!OPENAI_API_KEY || !DG_KEY) {
  console.error("❌ Missing API Keys. Check your .env file.");
  process.exit(1);
}

// ───────────────────────────────────────────────────────────────────────────────
// 2. CONVERSATION BRAIN
// ───────────────────────────────────────────────────────────────────────────────
class ConversationContext {
  constructor() {
    this.state = "greeting"; 
    this.data = {
      name: null,
      phone: "",       
      makeModel: null, 
      issue: null,     
      appointment: null
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 3. UTILITIES (Phone Number Extraction)
// ───────────────────────────────────────────────────────────────────────────────
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
  
  const match = q.match(/(\d{3})[\s.-]?(\d{3})[\s.-]?(\d{4})/);
  if (match) return match[0].replace(/\D/g, '');

  let i = 0;
  while (i < words.length) {
    const word = words[i];
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

  // 1. Phone Collection (Guided Chunking)
  if (ctx.state === "collect_phone") {
    const extracted = extractPhoneNumber(text);
    if (extracted) {
      ctx.data.phone += extracted;
      const len = ctx.data.phone.length;

      // Smart "Next Step" Prompts
      if (len === 3) {
         return `Got it, ${ctx.data.phone.split('').join(' ')}. What are the next three?`;
      }
      if (len === 6) {
         const last3 = ctx.data.phone.slice(3, 6).split('').join(' ');
         return `Okay, ${last3}. And the last four?`;
      }
      if (len >= 10) {
        ctx.state = "closing";
        // Trim to 10 if they gave too many
        const p = ctx.data.phone.slice(0, 10);
        const formatted = `${p[0]} ${p[1]} ${p[2]}, ${p[3]} ${p[4]} ${p[5]}, ${p[6]} ${p[7]} ${p[8]} ${p[9]}`;
        return `Perfect. I have ${formatted}. A mechanic will call you shortly to confirm. Thanks for choosing Mass Mechanic!`;
      }
      
      return `I have ${len} digits so far. What comes next?`;
    }
    
    return "I didn't catch that number. Could you start with just the area code?";
  }

  // 2. Global Commands
  if (q.includes("where") || q.includes("location") || q.includes("address") || q.includes("located")) {
    return "We are located at 123 Main Street in Boston. Can I help you schedule a repair?";
  }
  if (q.includes("hour") || q.includes("open") || q.includes("close")) {
    return "Mass Mechanic is open 8 AM to 6 PM, Monday through Friday.";
  }

  // 3. Greeting State
  if (ctx.state === "greeting") {
    if (q.includes("ford") || q.includes("toyota") || q.includes("honda") || q.includes("nissan") || q.includes("chevy") || q.includes("bmw") || q.includes("volvo")) {
      ctx.data.makeModel = text;
      ctx.state = "collect_issue";
      return "Got it. What seems to be the problem with the vehicle?";
    }
    if (q.includes("book") || q.includes("appointment") || q.includes("schedule") || q.includes("broken") || q.includes("repair") || q.includes("help") || q.includes("car")) {
      ctx.state = "collect_details";
      return "I can help with that. What is the Year, Make, and Model of your vehicle?";
    }
  }

  // 4. Vehicle Details
  if (ctx.state === "collect_details") {
    ctx.data.makeModel = text; 
    ctx.state = "collect_issue";
    return "Okay. And what seems to be the problem with the vehicle?";
  }

  // 5. Issue Details -> Start Phone Collection
  if (ctx.state === "collect_issue") {
    ctx.data.issue = text;
    ctx.state = "collect_phone";
    return "Understood. I'd like to have a mechanic call you back. What's your phone number? You can start with just the area code.";
  }

  // Fallback
  if (ctx.state === "greeting") {
      ctx.state = "collect_details";
      return "I can help you schedule a repair. What kind of car do you have?";
  }

  return "Could you repeat that? I can help you schedule a repair.";
}

// ───────────────────────────────────────────────────────────────────────────────
// 5. AUDIO PIPELINE (OpenAI TTS + FFmpeg MULAW)
// ───────────────────────────────────────────────────────────────────────────────
async function ttsToMulaw(text) { 
  const url = "https://api.openai.com/v1/audio/speech";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ 
      model: "tts-1", 
      voice: "shimmer", // <--- CHANGED: "shimmer" is often clearer/brighter than alloy
      input: text, 
      response_format: "pcm" 
    }),
  });

  if (!res.ok) throw new Error(`OpenAI Error: ${res.statusText}`);
  const inputBuffer = Buffer.from(await res.arrayBuffer());

  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegBin.path, [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0",
      "-f", "mulaw", "-ar", "8000", "-ac", "1", "pipe:1"
    ]);
    const chunks = [];
    ff.stdout.on("data", c => chunks.push(c));
    ff.on("close", () => resolve(Buffer.concat(chunks)));
    ff.on("error", reject);
    ff.stdin.end(inputBuffer);
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// 6. SERVER SETUP
// ───────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("🔗 Call Connected");
  ws._ctx = new ConversationContext();
  ws._speaking = false;

  const dg = new WebSocket(`wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&endpointing=true`, {
    headers: { Authorization: `Token ${DG_KEY}` }
  });

  dg.on("message", async (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.is_final && msg.channel?.alternatives?.[0]?.transcript) {
      const transcript = msg.channel.alternatives[0].transcript;
      if (!transcript.trim()) return;
      
      console.log(`User: ${transcript}`);
      
      // <--- BARGE-IN FIX: If user speaks, STOP the bot's current audio immediately
      if (ws._speaking) {
         console.log("!! Barge-in detected: Clearing audio !!");
         ws.send(JSON.stringify({ event: "clear", streamSid: ws._streamSid }));
      }

      const reply = routeIntent(transcript, ws._ctx);
      console.log(`Bot: ${reply}`);

      ws._speaking = true;
      try {
        const audio = await ttsToMulaw(reply);
        const FRAME_SIZE = 160; 
        for (let i = 0; i < audio.length; i += FRAME_SIZE) {
          if (ws.readyState !== ws.OPEN) break;
          const frame = audio.slice(i, i + FRAME_SIZE).toString("base64");
          ws.send(JSON.stringify({ event: "media", streamSid: ws._streamSid, media: { payload: frame } }));
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
      console.log("Call Started");
      
      const greeting = "Hi! Thanks for calling Mass Mechanic. I can help you schedule a repair or answer questions. How can I help?";
      
      (async () => {
         ws._speaking = true;
         const audio = await ttsToMulaw(greeting);
         const FRAME_SIZE = 160;
         for (let i = 0; i < audio.length; i += FRAME_SIZE) {
           if (ws.readyState !== ws.OPEN) break;
           ws.send(JSON.stringify({ event: "media", streamSid: ws._streamSid, media: { payload: audio.slice(i, i + FRAME_SIZE).toString("base64") } }));
           await new Promise(r => setTimeout(r, 20));
         }
         ws._speaking = false;
      })();
    }
    if (data.event === "media" && dg.readyState === dg.OPEN) {
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

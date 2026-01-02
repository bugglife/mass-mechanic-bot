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

const TENS_MAP = {
  'twenty': '2', 'thirty': '3', 'forty': '4', 'fifty': '5',
  'sixty': '6', 'seventy': '7', 'eighty': '8', 'ninety': '9'
};

function extractPhoneNumber(text) {
  const q = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
  let digits = '';
  const words = q.split(/\s+/);
  
  // Standard regex match
  const match = q.match(/(\d{3})[\s.-]?(\d{3})[\s.-]?(\d{4})/);
  if (match) return match[0].replace(/\D/g, '');

  let i = 0;
  while (i < words.length) {
    const word = words[i];

    // 1. Handle "Two Hundred" -> 200
    if (word === 'hundred') {
        digits += "00";
        i++; continue;
    }

    // 2. Handle "Thirty", "Sixty-four"
    if (TENS_MAP[word]) {
       const firstDigit = TENS_MAP[word];
       if (i + 1 < words.length && NUMBER_WORDS_MAP[words[i+1]] && NUMBER_WORDS_MAP[words[i+1]].length === 1) {
           digits += firstDigit + NUMBER_WORDS_MAP[words[i+1]];
           i += 2; continue;
       } else {
           digits += firstDigit + '0';
           i++; continue;
       }
    }

    // 3. Handle "double 5"
    if (word === 'double' && i + 1 < words.length) {
      const nextDigit = NUMBER_WORDS_MAP[words[i + 1]];
      if (nextDigit && nextDigit.length === 1) {
        digits += nextDigit + nextDigit;
        i += 2; continue;
      }
    }
    
    // 4. Standard words
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

  // 1. Phone Collection
  if (ctx.state === "collect_phone") {
    const extracted = extractPhoneNumber(text);
    if (extracted) {
      ctx.data.phone += extracted;
    }
    
    const len = ctx.data.phone.length;
    const p = ctx.data.phone;

    if (len === 3) {
       return `Got it, area code ${p.split('').join(' ')}. What are the next three digits?`;
    }
    if (len === 6) {
       const last3 = p.slice(3, 6).split('').join(' ');
       return `Okay, ${last3}. And the last four?`;
    }
    if (len === 9) {
       return `Almost there. Just one digit left. What is the last number?`;
    }
    if (len >= 10) {
      ctx.state = "closing"; 
      const clean = p.slice(0, 10);
      // <--- FIX: Added spaces between EVERY digit so it reads them individually
      const formatted = `${clean[0]} ${clean[1]} ${clean[2]}... ${clean[3]} ${clean[4]} ${clean[5]}... ${clean[6]} ${clean[7]} ${clean[8]} ${clean[9]}`;
      return `Perfect, I have ${formatted}. I'll have a senior mechanic call you shortly to confirm the details. Thanks for calling Mass Mechanic!`;
    }
    
    if (len > 0) {
       if (len < 3) return `I have ${p.split('').join(' ')} so far. What is the rest of the area code?`;
       if (len < 6) return `I have the area code. What are the next three digits?`;
       return `Sorry, I missed that last part. I have ${len} digits so far. What are the last few?`;
    }

    return "I didn't quite catch that. Could you start with just the area code? For example, 6 1 7.";
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
    if (q.includes("ford") || q.includes("toyota") || q.includes("honda") || q.includes("nissan") || q.includes("chevy") || q.includes("bmw") || q.includes("volvo") || q.includes("jeep")) {
      ctx.data.makeModel = text;
      ctx.state = "collect_issue";
      return "Got it. I can definitely help get that checked out. What seems to be the problem with the vehicle?";
    }
    if (q.includes("book") || q.includes("appointment") || q.includes("schedule") || q.includes("broken") || q.includes("repair") || q.includes("help") || q.includes("car")) {
      ctx.state = "collect_details";
      return "I'd be happy to help you with that. To get started, what is the Year, Make, and Model of your car?";
    }
  }

  // 4. Vehicle Details
  if (ctx.state === "collect_details") {
    ctx.data.makeModel = text; 
    ctx.state = "collect_issue";
    return "Okay, got it. And can you tell me a little bit about what's going on with it?";
  }

  // 5. Issue Details -> Start Phone Collection
  if (ctx.state === "collect_issue") {
    ctx.data.issue = text;
    ctx.state = "collect_phone";
    if (text.split(" ").length < 3) {
        return "Understood. I'd like to have a mechanic look at that. What's the best phone number to reach you at?";
    }
    return "Oof, I hear you. That sounds frustrating. I want to get a pro to take a look at that ASAP. What's the best phone number to reach you at? You can start with just the area code.";
  }

  // Fallback
  if (ctx.state === "greeting") {
      ctx.state = "collect_details";
      return "I can help you schedule a repair. What kind of car do you have?";
  }

  return "Could you repeat that? I can help you schedule a repair.";
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
    body: JSON.stringify({ 
      model: "tts-1", 
      voice: "shimmer", 
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
  ws._currentMsgId = 0; 

  const dg = new WebSocket(`wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&endpointing=true`, {
    headers: { Authorization: `Token ${DG_KEY}` }
  });

  dg.on("message", async (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.is_final && msg.channel?.alternatives?.[0]?.transcript) {
      const transcript = msg.channel.alternatives[0].transcript;
      if (!transcript.trim()) return;
      
      console.log(`User: ${transcript}`);
      
      if (ws._speaking) {
         console.log("!! Barge-in: Clearing audio !!");
         ws.send(JSON.stringify({ event: "clear", streamSid: ws._streamSid }));
      }
      ws._currentMsgId++; 

      const reply = routeIntent(transcript, ws._ctx);
      console.log(`Bot: ${reply}`);

      ws._speaking = true;
      const myMsgId = ws._currentMsgId; 

      try {
        const audio = await ttsToMulaw(reply);
        
        if (ws._currentMsgId !== myMsgId) return;

        const FRAME_SIZE = 160; 
        for (let i = 0; i < audio.length; i += FRAME_SIZE) {
          if (ws._currentMsgId !== myMsgId || ws.readyState !== ws.OPEN) break;
          const frame = audio.slice(i, i + FRAME_SIZE).toString("base64");
          ws.send(JSON.stringify({ event: "media", streamSid: ws._streamSid, media: { payload: frame } }));
          await new Promise(r => setTimeout(r, 20));
        }

        if (ws._ctx.state === "closing" && ws._currentMsgId === myMsgId) {
           console.log("Conversation complete. Hanging up in 3s...");
           setTimeout(() => {
             if (ws._currentMsgId === myMsgId) {
                 console.log("Closing socket.");
                 ws.close(); 
             }
           }, 3000);
        }

      } catch (e) {
        console.error(e);
      } finally {
        if (ws._currentMsgId === myMsgId) {
            ws._speaking = false;
        }
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
         ws._currentMsgId++;
         const myMsgId = ws._currentMsgId;
         
         const audio = await ttsToMulaw(greeting);
         const FRAME_SIZE = 160;
         for (let i = 0; i < audio.length; i += FRAME_SIZE) {
           if (ws._currentMsgId !== myMsgId || ws.readyState !== ws.OPEN) break;
           ws.send(JSON.stringify({ event: "media", streamSid: ws._streamSid, media: { payload: audio.slice(i, i + FRAME_SIZE).toString("base64") } }));
           await new Promise(r => setTimeout(r, 20));
         }
         if (ws._currentMsgId === myMsgId) ws._speaking = false;
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

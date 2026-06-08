"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

loadEnvFile(path.join(ROOT_DIR, ".env"));
loadEnvFile(path.join(ROOT_DIR, ".env.local"));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2";
const TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-realtime-whisper";
const TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const LEVELS = {
  beginner: "A1-A2 beginner",
  elementary: "A2-B1 elementary",
  intermediate: "B1-B2 intermediate",
  advanced: "C1 advanced"
};

const TOPICS = {
  daily: "daily life and small talk",
  travel: "travel, directions, hotels, and transport",
  work: "workplace communication and meetings",
  interview: "job interview practice",
  shopping: "shopping, restaurants, and services",
  ielts: "IELTS-style speaking prompts",
  custom: "custom learner topic"
};

const LANGUAGES = {
  english: "English",
  vietnamese: "Vietnamese",
  japanese: "Japanese",
  korean: "Korean",
  chinese: "Chinese",
  french: "French"
};

const CORRECTION_STYLES = {
  gentle: "Correct gently after the learner finishes a thought.",
  instant: "Correct short pronunciation or grammar mistakes immediately when it will not interrupt fluency.",
  recap: "Let the conversation flow, then give a compact recap with corrections every few turns."
};

const VOICE_PERSONAS = {
  mai: { voice: "marin", name: "Cô Mai", style: "warm, bright, and encouraging", description: "ấm áp, rõ ràng" },
  nam: { voice: "cedar", name: "Thầy Nam", style: "calm, grounded, and patient", description: "trầm ấm, chắc chắn" },
  san: { voice: "coral", name: "Cô San", style: "cheerful, lively, and friendly", description: "tươi sáng, vui vẻ" },
  minh: { voice: "sage", name: "Thầy Minh", style: "gentle, thoughtful, and clear", description: "điềm tĩnh, dễ nghe" },
  van: { voice: "verse", name: "Bạn Vân", style: "storytelling, playful, and expressive", description: "kể chuyện, giàu cảm xúc" },
  an: { voice: "alloy", name: "Bạn An", style: "neutral, clear, and upbeat", description: "trung tính, sáng" },
  khanh: { voice: "ash", name: "Bạn Khánh", style: "energetic, crisp, and confident", description: "năng động, rõ chữ" },
  linh: { voice: "ballad", name: "Cô Linh", style: "soft, smooth, and supportive", description: "dịu dàng, mềm mại" },
  long: { voice: "echo", name: "Bạn Long", style: "clear, resonant, and direct", description: "rõ, vang" },
  ngoc: { voice: "shimmer", name: "Bạn Ngọc", style: "bright, light, and positive", description: "sáng, thân thiện" }
};

const VOICES = new Set(Object.keys(VOICE_PERSONAS));
const LEGACY_VOICE_ALIASES = Object.fromEntries(
  Object.entries(VOICE_PERSONAS).map(([key, persona]) => [persona.voice, key])
);

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        ready: Boolean(process.env.OPENAI_API_KEY)
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/realtime-token") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    if (req.method === "POST" && req.url === "/api/voice-preview") {
      await handleVoicePreviewRequest(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/realtime") {
      await handleRealtimeRequest(req, res);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Unexpected server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Giaotiep AI running at http://${HOST}:${PORT}`);
  if (!process.env.OPENAI_API_KEY) {
    console.log("OPENAI_API_KEY is not set. Add it to .env.local before starting a realtime call.");
  }
});

async function handleRealtimeRequest(req, res) {
  if (!process.env.OPENAI_API_KEY) {
    sendJson(res, 500, { error: "Server is not configured" });
    return;
  }

  const payload = await readJson(req, 1_200_000);
  const sdp = typeof payload.sdp === "string" ? payload.sdp : "";

  if (!sdp.startsWith("v=") || sdp.length < 50) {
    sendJson(res, 400, { error: "Invalid session offer" });
    return;
  }

  const profile = normalizeProfile(payload);
  const session = buildRealtimeSession(profile);
  const safetyIdentifier = hashSafetyIdentifier(req);
  const upstream = await createRealtimeCall(sdp, session, safetyIdentifier);

  if (upstream.status < 200 || upstream.status >= 300) {
    console.error("Realtime API error:", upstream.status, upstream.body.slice(0, 1000));
    sendJson(res, upstream.status, {
      error: "Could not create the practice session",
      detail: "Không tạo được phiên luyện. Vui lòng thử lại."
    });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/sdp",
    "Cache-Control": "no-store"
  });
  res.end(upstream.body);
}

async function handleRealtimeTokenRequest(req, res) {
  if (!process.env.OPENAI_API_KEY) {
    sendJson(res, 500, { error: "Server is not configured" });
    return;
  }

  const payload = await readJson(req, 120_000);
  const profile = normalizeProfile(payload);
  const session = buildRealtimeSession(profile);
  const safetyIdentifier = hashSafetyIdentifier(req);
  const upstream = await createRealtimeClientSecret(session, safetyIdentifier);

  if (upstream.status < 200 || upstream.status >= 300) {
    console.error("Realtime token error:", upstream.status, upstream.body.slice(0, 1000));
    sendJson(res, upstream.status, {
      error: "Could not create a Realtime token",
      detail: safeUpstreamMessage(upstream.body)
    });
    return;
  }

  let data;
  try {
    data = JSON.parse(upstream.body);
  } catch (error) {
    sendJson(res, 502, { error: "Realtime token response was not JSON" });
    return;
  }

  const token = data.value || (data.client_secret && data.client_secret.value);
  if (!token) {
    sendJson(res, 502, { error: "Realtime token response did not include a client secret" });
    return;
  }

  sendJson(res, 200, {
    value: token,
    expires_at: data.expires_at || (data.client_secret && data.client_secret.expires_at),
    session: data.session || null
  });
}

async function handleVoicePreviewRequest(req, res) {
  if (!process.env.OPENAI_API_KEY) {
    sendJson(res, 500, { error: "Server is not configured" });
    return;
  }

  const payload = await readJson(req, 60_000);
  const profile = normalizeProfile(payload);
  const upstream = await createSpeechPreview(profile, hashSafetyIdentifier(req));

  if (upstream.status < 200 || upstream.status >= 300) {
    console.error("Voice preview error:", upstream.status, upstream.body.toString("utf8").slice(0, 1000));
    sendJson(res, upstream.status, {
      error: "Could not create voice preview",
      detail: "Không tạo được giọng nghe thử. Vui lòng thử lại."
    });
    return;
  }

  res.writeHead(200, {
    "Content-Type": upstream.contentType || "audio/mpeg",
    "Content-Length": upstream.body.length,
    "Cache-Control": "no-store"
  });
  res.end(upstream.body);
}

function normalizeProfile(payload) {
  const level = pick(payload.level, LEVELS, "beginner");
  const topic = pick(payload.topic, TOPICS, "daily");
  const goalLanguage = pick(payload.goalLanguage, LANGUAGES, "english");
  const correctionStyle = pick(payload.correctionStyle, CORRECTION_STYLES, "gentle");
  const voiceKey = normalizeVoiceKey(payload.voice);
  const persona = VOICE_PERSONAS[voiceKey];
  const speed = clamp(Number(payload.speed || 1), 0.75, 1.2);
  const customTopic = cleanText(payload.customTopic, 90);

  return {
    level,
    topic,
    goalLanguage,
    correctionStyle,
    voiceKey,
    outputVoice: persona.voice,
    speed,
    voiceName: persona.name,
    voiceStyle: persona.style,
    voiceDescription: persona.description,
    topicLabel: topic === "custom" && customTopic ? customTopic : TOPICS[topic],
    languageLabel: LANGUAGES[goalLanguage]
  };
}

function buildRealtimeSession(profile) {
  return {
    type: "realtime",
    model: REALTIME_MODEL,
    instructions: buildCoachInstructions(profile),
    max_output_tokens: 900,
    output_modalities: ["audio"],
    audio: {
      input: {
        noise_reduction: { type: "near_field" },
        transcription: {
          model: TRANSCRIPTION_MODEL
        },
        turn_detection: {
          type: "server_vad",
          create_response: true,
          interrupt_response: true,
          threshold: 0.55,
          prefix_padding_ms: 300,
          silence_duration_ms: 650
        }
      },
      output: {
        voice: profile.outputVoice,
        speed: profile.speed
      }
    }
  };
}

function buildCoachInstructions(profile) {
  return [
    `You are ${profile.voiceName}, a warm realtime speaking coach for a Vietnamese learner practicing ${profile.languageLabel}.`,
    `Your speaking style is ${profile.voiceStyle}.`,
    `Practice level: ${LEVELS[profile.level]}. Topic: ${profile.topicLabel}.`,
    "Start the session with a short greeting in the target language and one easy question.",
    "Keep every spoken turn short, natural, and interactive. Ask one follow-up question at a time.",
    "Adapt vocabulary, speed, and grammar to the learner's level. If the learner struggles, give a tiny hint or two choices.",
    CORRECTION_STYLES[profile.correctionStyle],
    "When correcting, give the improved sentence first, then one brief Vietnamese explanation if needed.",
    "Prioritize speaking practice over long explanations. Do not lecture.",
    "If the learner uses Vietnamese because they are stuck, answer briefly in Vietnamese, then guide them back into the target language.",
    "At natural pauses, teach one useful phrase connected to the topic."
  ].join(" ");
}

function buildPreviewText(profile) {
  return `Xin chào, mình là ${profile.voiceName}. Hôm nay mình sẽ luyện nói cùng bạn. Are you ready?`;
}

function createRealtimeCall(sdp, session, safetyIdentifier) {
  return new Promise((resolve, reject) => {
    const boundary = `----giaotiep-ai-${crypto.randomBytes(12).toString("hex")}`;
    const body = Buffer.concat([
      multipartField(boundary, "sdp", sdp, "application/sdp"),
      multipartField(boundary, "session", JSON.stringify(session), "application/json"),
      Buffer.from(`--${boundary}--\r\n`)
    ]);

    const request = https.request({
      method: "POST",
      hostname: "api.openai.com",
      path: "/v1/realtime/calls",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
        "OpenAI-Safety-Identifier": safetyIdentifier
      }
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode || 500,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });

    request.setTimeout(30000, () => {
      request.destroy(new Error("Realtime API request timed out"));
    });
    request.on("error", reject);
    request.end(body);
  });
}

function createRealtimeClientSecret(session, safetyIdentifier) {
  const body = JSON.stringify({ session });

  return new Promise((resolve, reject) => {
    const request = https.request({
      method: "POST",
      hostname: "api.openai.com",
      path: "/v1/realtime/client_secrets",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "OpenAI-Safety-Identifier": safetyIdentifier
      }
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode || 500,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });

    request.setTimeout(30000, () => {
      request.destroy(new Error("Realtime token request timed out"));
    });
    request.on("error", reject);
    request.end(body);
  });
}

function createSpeechPreview(profile, safetyIdentifier) {
  const body = JSON.stringify({
    model: TTS_MODEL,
    voice: profile.outputVoice,
    input: buildPreviewText(profile),
    instructions: `Speak as ${profile.voiceName}: ${profile.voiceStyle}. Keep it friendly for a school student learning a language. Make pronunciation clear and the pace comfortable.`,
    response_format: "mp3",
    speed: profile.speed
  });

  return new Promise((resolve, reject) => {
    const request = https.request({
      method: "POST",
      hostname: "api.openai.com",
      path: "/v1/audio/speech",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "OpenAI-Safety-Identifier": safetyIdentifier
      }
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode || 500,
          body: Buffer.concat(chunks),
          contentType: response.headers["content-type"]
        });
      });
    });

    request.setTimeout(30000, () => {
      request.destroy(new Error("Voice preview request timed out"));
    });
    request.on("error", reject);
    request.end(body);
  });
}

function multipartField(boundary, name, value, contentType) {
  return Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${name}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n` +
    `${value}\r\n`,
    "utf8"
  );
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(data);
  });
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];

    req.on("data", chunk => {
      received += chunk.length;
      if (received > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(new Error("Invalid JSON request body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function pick(value, allowed, fallback) {
  return Object.prototype.hasOwnProperty.call(allowed, value) ? value : fallback;
}

function normalizeVoiceKey(value) {
  if (VOICES.has(value)) {
    return value;
  }
  if (Object.prototype.hasOwnProperty.call(LEGACY_VOICE_ALIASES, value)) {
    return LEGACY_VOICE_ALIASES[value];
  }
  return "mai";
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(max, Math.max(min, value));
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/[<>]/g, "").trim().slice(0, maxLength);
}

function safeUpstreamMessage(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed.error && parsed.error.message ? parsed.error.message : parsed;
  } catch (error) {
    return body.slice(0, 500);
  }
}

function hashSafetyIdentifier(req) {
  const ip = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "local";
  const userAgent = req.headers["user-agent"] || "unknown";
  return crypto.createHash("sha256").update(`${ip}:${userAgent}`).digest("hex");
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

"use strict";

const elements = {
  serverStatus: document.getElementById("serverStatus"),
  connectionStatus: document.getElementById("connectionStatus"),
  goalLanguage: document.getElementById("goalLanguage"),
  level: document.getElementById("level"),
  topic: document.getElementById("topic"),
  customTopic: document.getElementById("customTopic"),
  correctionStyle: document.getElementById("correctionStyle"),
  voice: document.getElementById("voice"),
  previewVoiceBtn: document.getElementById("previewVoiceBtn"),
  voiceMeta: document.getElementById("voiceMeta"),
  speed: document.getElementById("speed"),
  speedValue: document.getElementById("speedValue"),
  startBtn: document.getElementById("startBtn"),
  startBtnLabel: document.getElementById("startBtnLabel"),
  muteBtn: document.getElementById("muteBtn"),
  stopBtn: document.getElementById("stopBtn"),
  clearBtn: document.getElementById("clearBtn"),
  sessionTitle: document.getElementById("sessionTitle"),
  transcript: document.getElementById("transcript"),
  liveUserCaption: document.getElementById("liveUserCaption"),
  liveAiCaption: document.getElementById("liveAiCaption"),
  remoteAudio: document.getElementById("remoteAudio"),
  waveform: document.getElementById("waveform"),
  voiceSurface: document.querySelector(".voice-surface")
};

const topicLabels = {
  daily: "Đời sống hằng ngày",
  travel: "Du lịch",
  work: "Công việc",
  interview: "Phỏng vấn",
  shopping: "Mua sắm, nhà hàng",
  ielts: "IELTS Speaking",
  custom: "Chủ đề tự nhập"
};

const voiceLabels = {
  mai: { name: "Cô Mai", description: "ấm áp, rõ ràng" },
  nam: { name: "Thầy Nam", description: "trầm ấm, chắc chắn" },
  san: { name: "Cô San", description: "tươi sáng, vui vẻ" },
  minh: { name: "Thầy Minh", description: "điềm tĩnh, dễ nghe" },
  van: { name: "Bạn Vân", description: "kể chuyện, giàu cảm xúc" },
  an: { name: "Bạn An", description: "trung tính, sáng" },
  khanh: { name: "Bạn Khánh", description: "năng động, rõ chữ" },
  linh: { name: "Cô Linh", description: "dịu dàng, mềm mại" },
  long: { name: "Bạn Long", description: "rõ, vang" },
  ngoc: { name: "Bạn Ngọc", description: "sáng, thân thiện" }
};

let peerConnection = null;
let dataChannel = null;
let localStream = null;
let audioContext = null;
let analyser = null;
let animationId = null;
let muted = false;
let userDraft = null;
let assistantDraft = null;
let assistantDraftResponseId = null;
let assistantDeltaSource = null;
let previewAudio = null;
const voicePreviewCache = new Map();
const completedAssistantResponses = new Set();
const recentAssistantTexts = [];

checkServer();
updateVoiceMeta();
updateSpeedValue();
drawIdleWave();

elements.topic.addEventListener("change", () => {
  const isCustom = elements.topic.value === "custom";
  elements.customTopic.classList.toggle("hidden", !isCustom);
  updateSessionTitle();
});
elements.customTopic.addEventListener("input", updateSessionTitle);
elements.voice.addEventListener("change", updateVoiceMeta);
elements.speed.addEventListener("input", updateSpeedValue);
elements.previewVoiceBtn.addEventListener("click", previewVoice);
elements.startBtn.addEventListener("click", startSession);
elements.stopBtn.addEventListener("click", stopSession);
elements.muteBtn.addEventListener("click", toggleMute);
elements.clearBtn.addEventListener("click", clearTranscript);
document.getElementById("clearBtnDuplicate").addEventListener("click", () => {
  elements.transcript.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

async function checkServer() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const data = await response.json();
    if (data.ready) {
      setStatus(elements.serverStatus, "Sẵn sàng luyện nói", "ok");
    } else {
      setStatus(elements.serverStatus, "Chưa cấu hình máy chủ", "warn");
    }
  } catch (error) {
    setStatus(elements.serverStatus, "Server chưa sẵn sàng", "error");
  }
}

async function startSession() {
  if (peerConnection) {
    return;
  }

  setBusy(true);
  setStartButtonLabel("Đang kết nối");
  clearDraft();
  stopVoicePreview();
  setStatus(elements.connectionStatus, "Đang xin quyền mic", "wait");

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    resetLiveCaptions();
    setupAudioMeter(localStream);
    peerConnection = new RTCPeerConnection();
    dataChannel = peerConnection.createDataChannel("oai-events");

    peerConnection.ontrack = event => {
      elements.remoteAudio.srcObject = event.streams[0];
    };

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection ? peerConnection.connectionState : "closed";
      if (state === "connected") {
        setStatus(elements.connectionStatus, "Đang luyện nói", "ok");
      } else if (state === "failed" || state === "disconnected") {
        setStatus(elements.connectionStatus, "Mất kết nối", "error");
      } else if (state !== "closed") {
        setStatus(elements.connectionStatus, `Kết nối: ${state}`, "wait");
      }
    };

    dataChannel.addEventListener("open", () => {
      setStatus(elements.connectionStatus, "Đang chờ AI chào", "ok");
      sendClientEvent({
        type: "response.create",
        response: {
          instructions: "Start now with a friendly one-sentence greeting and one simple question for the learner."
        }
      });
    });
    dataChannel.addEventListener("message", event => handleServerEvent(event));
    dataChannel.addEventListener("error", () => {
      appendMessage("system", "Hệ thống", "Data channel gặp lỗi.");
    });

    for (const track of localStream.getAudioTracks()) {
      peerConnection.addTrack(track, localStream);
    }

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    setStatus(elements.connectionStatus, "Đang tạo phiên luyện", "wait");

    const response = await fetch("/api/realtime", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...getProfile(),
        sdp: offer.sdp
      })
    });

    setStatus(elements.connectionStatus, "Đang kết nối lớp học", "wait");
    const answerText = await response.text();
    if (!response.ok) {
      throw new Error(readApiError(answerText));
    }

    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: answerText
    });

    muted = false;
    elements.muteBtn.disabled = false;
    elements.stopBtn.disabled = false;
    elements.voiceSurface.classList.add("is-listening");
    setStartButtonLabel("Đang luyện");
    setStatus(elements.connectionStatus, "Đang kết nối âm thanh", "wait");
  } catch (error) {
    appendMessage("system notice", "Lỗi", error.message || "Không thể bắt đầu phiên luyện.");
    setStatus(elements.connectionStatus, "Không kết nối được", "error");
    stopSession();
  } finally {
    setBusy(false);
  }
}

function stopSession() {
  if (dataChannel) {
    dataChannel.close();
    dataChannel = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (localStream) {
    for (const track of localStream.getTracks()) {
      track.stop();
    }
    localStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  analyser = null;
  userDraft = null;
  assistantDraft = null;
  elements.remoteAudio.srcObject = null;
  elements.muteBtn.disabled = true;
  elements.stopBtn.disabled = true;
  elements.startBtn.disabled = false;
  setStartButtonLabel("Bắt đầu nói");
  elements.voiceSurface.classList.remove("is-listening");
  drawIdleWave();
  setStatus(elements.connectionStatus, "Chưa kết nối");
}

function toggleMute() {
  if (!localStream) {
    return;
  }

  muted = !muted;
  for (const track of localStream.getAudioTracks()) {
    track.enabled = !muted;
  }

  elements.muteBtn.title = muted ? "Bật mic" : "Tắt mic";
  elements.muteBtn.setAttribute("aria-label", muted ? "Bật mic" : "Tắt mic");
  setStatus(elements.connectionStatus, muted ? "Mic đang tắt" : "Đang luyện nói", muted ? "warn" : "ok");
}

function getProfile() {
  return {
    goalLanguage: elements.goalLanguage.value,
    level: elements.level.value,
    topic: elements.topic.value,
    customTopic: elements.customTopic.value,
    correctionStyle: elements.correctionStyle.value,
    voice: elements.voice.value,
    speed: Number(elements.speed.value)
  };
}

async function previewVoice() {
  const voice = elements.voice.value;
  const cacheKey = `${voice}:${elements.speed.value}`;

  try {
    elements.previewVoiceBtn.disabled = true;
    elements.previewVoiceBtn.classList.add("is-playing");

    let audioUrl = voicePreviewCache.get(cacheKey);
    if (!audioUrl) {
      const response = await fetch("/api/voice-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(getProfile())
      });

      if (!response.ok) {
        throw new Error(readApiError(await response.text()));
      }

      audioUrl = URL.createObjectURL(await response.blob());
      voicePreviewCache.set(cacheKey, audioUrl);
    }

    stopVoicePreview(false);
    previewAudio = new Audio(audioUrl);
    previewAudio.addEventListener("ended", resetPreviewButton, { once: true });
    previewAudio.addEventListener("error", resetPreviewButton, { once: true });
    await previewAudio.play();
  } catch (error) {
    resetPreviewButton();
    appendMessage("system notice", "Lỗi", error.message || "Không thể nghe thử giọng này.");
  }
}

function stopVoicePreview(resetButton = true) {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.currentTime = 0;
    previewAudio = null;
  }
  if (resetButton) {
    resetPreviewButton();
  }
}

function resetPreviewButton() {
  elements.previewVoiceBtn.disabled = false;
  elements.previewVoiceBtn.classList.remove("is-playing");
}

function setStartButtonLabel(text) {
  elements.startBtnLabel.textContent = text;
}

function updateVoiceMeta() {
  const voice = elements.voice.value;
  const label = voiceLabels[voice];
  elements.voiceMeta.textContent = label
    ? `${label.name} - ${label.description}`
    : "Giọng luyện nói";
}

function updateSpeedValue() {
  elements.speedValue.textContent = `${Number(elements.speed.value).toFixed(2)}x`;
}

function updateSessionTitle() {
  const topic = elements.topic.value;
  if (topic === "custom" && elements.customTopic.value.trim()) {
    elements.sessionTitle.textContent = elements.customTopic.value.trim();
    return;
  }
  elements.sessionTitle.textContent = topicLabels[topic] || "Phiên luyện nói";
}

function handleServerEvent(event) {
  let payload;
  try {
    payload = JSON.parse(event.data);
  } catch (error) {
    return;
  }

  switch (payload.type) {
    case "conversation.item.input_audio_transcription.delta":
      appendUserDelta(payload.delta || "");
      break;
    case "conversation.item.input_audio_transcription.completed":
      finishUserTranscript(payload.transcript || "");
      break;
    case "response.audio_transcript.delta":
    case "response.output_audio_transcript.delta":
    case "response.text.delta":
      appendAssistantDelta(payload);
      break;
    case "response.audio_transcript.done":
    case "response.output_audio_transcript.done":
    case "response.text.done":
      finishAssistantDraft(payload);
      break;
    case "response.done":
      finishFromResponse(payload.response);
      break;
    case "error":
      appendMessage("system notice", "Lỗi", payload.error && payload.error.message ? payload.error.message : "Phiên luyện báo lỗi.");
      break;
    default:
      break;
  }
}

function sendClientEvent(payload) {
  if (dataChannel && dataChannel.readyState === "open") {
    dataChannel.send(JSON.stringify(payload));
  }
}

function appendAssistantDelta(payload) {
  const delta = payload.delta || "";
  if (!delta) {
    return;
  }

  const responseId = getResponseId(payload);
  const source = getAssistantEventSource(payload.type);

  if (!assistantDraft || assistantDraftResponseId !== responseId) {
    assistantDraft = appendMessage("assistant", "AI", "");
    assistantDraftResponseId = responseId;
    assistantDeltaSource = source;
  } else if (assistantDeltaSource && assistantDeltaSource !== source) {
    return;
  }

  const paragraph = assistantDraft.querySelector("p");
  paragraph.textContent += delta;
  setLiveCaption("assistant", paragraph.textContent);
  scrollTranscript(assistantDraft);
}

function finishAssistantDraft(payload) {
  const finalText = payload.transcript || payload.text || "";
  const responseId = getResponseId(payload);
  const source = getAssistantEventSource(payload.type);

  if (assistantDeltaSource && assistantDeltaSource !== source) {
    return;
  }

  if (!assistantDraft && finalText) {
    if (isDuplicateAssistantCompletion(responseId, finalText)) {
      return;
    }
    assistantDraft = appendMessage("assistant", "AI", finalText);
    assistantDraftResponseId = responseId;
    assistantDeltaSource = source;
  }

  if (assistantDraft && finalText) {
    assistantDraft.querySelector("p").textContent = finalText;
  }
  if (finalText) {
    setLiveCaption("assistant", finalText);
  }
  const finishedDraft = assistantDraft;
  const completedText = finishedDraft ? finishedDraft.querySelector("p").textContent : finalText;
  rememberAssistantCompletion(responseId, completedText);
  assistantDraft = null;
  assistantDraftResponseId = null;
  assistantDeltaSource = null;
  scrollTranscript(finishedDraft);
}

function finishFromResponse(response) {
  if (!response) {
    return;
  }

  const responseId = response.id || assistantDraftResponseId || "active";
  const text = extractTranscript(response);

  if (assistantDraft) {
    if (text) {
      assistantDraft.querySelector("p").textContent = text;
      setLiveCaption("assistant", text);
      rememberAssistantCompletion(responseId, text);
    }
    const finishedDraft = assistantDraft;
    assistantDraft = null;
    assistantDraftResponseId = null;
    assistantDeltaSource = null;
    scrollTranscript(finishedDraft);
    return;
  }

  if (text && !isDuplicateAssistantCompletion(responseId, text)) {
    const message = appendMessage("assistant", "AI", text);
    setLiveCaption("assistant", text);
    rememberAssistantCompletion(responseId, text);
    scrollTranscript(message);
  }
}

function appendUserDelta(delta) {
  if (!delta) {
    return;
  }

  if (!userDraft) {
    userDraft = appendMessage("user", "Bạn", "");
  }

  const paragraph = userDraft.querySelector("p");
  paragraph.textContent += delta;
  setLiveCaption("user", paragraph.textContent);
  scrollTranscript(userDraft);
}

function finishUserTranscript(finalText) {
  if (!finalText && !userDraft) {
    return;
  }

  if (!userDraft) {
    userDraft = appendMessage("user", "Bạn", finalText);
  } else if (finalText) {
    userDraft.querySelector("p").textContent = finalText;
  }

  const text = userDraft.querySelector("p").textContent;
  setLiveCaption("user", text);
  const finishedDraft = userDraft;
  userDraft = null;
  scrollTranscript(finishedDraft);
}

function extractTranscript(response) {
  const output = Array.isArray(response.output) ? response.output : [];
  const chunks = [];

  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part.transcript) {
        chunks.push(part.transcript);
      } else if (part.text) {
        chunks.push(part.text);
      }
    }
  }

  return chunks.join(" ").trim();
}

function appendMessage(role, label, text) {
  const message = document.createElement("article");
  message.className = `message ${role}`;
  const avatar = document.createElement("div");
  avatar.className = role.includes("user") ? "message-avatar user-avatar" : "message-avatar ai-avatar";
  avatar.setAttribute("aria-hidden", "true");
  const content = document.createElement("div");
  content.className = "bubble-content";
  const speaker = document.createElement("span");
  speaker.textContent = label;
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  content.append(speaker, paragraph);
  message.append(avatar, content);
  elements.transcript.appendChild(message);
  scrollTranscript(message);
  return message;
}

function clearTranscript() {
  clearDraft();
  elements.transcript.innerHTML = "";
  resetLiveCaptions();
}

function clearDraft() {
  userDraft = null;
  assistantDraft = null;
  assistantDraftResponseId = null;
  assistantDeltaSource = null;
  clearCurrentMessage();
}

function setLiveCaption(role, text) {
  const target = role === "user" ? elements.liveUserCaption : elements.liveAiCaption;
  target.textContent = text && text.trim() ? text.trim() : "Chưa có thoại";
}

function resetLiveCaptions() {
  setLiveCaption("user", "");
  setLiveCaption("assistant", "");
}

function clearCurrentMessage() {
  for (const message of elements.transcript.querySelectorAll(".is-current")) {
    message.classList.remove("is-current");
  }
}

function markCurrentMessage(message) {
  if (!message) {
    return;
  }

  clearCurrentMessage();
  message.classList.add("is-current");
}

function scrollTranscript(message) {
  if (message) {
    markCurrentMessage(message);
  }

  requestAnimationFrame(() => {
    if (message && message.isConnected) {
      message.scrollIntoView({ block: "end", behavior: "smooth" });
      return;
    }
    elements.transcript.scrollTo({
      top: elements.transcript.scrollHeight,
      behavior: "smooth"
    });
  });
}

function getResponseId(payload) {
  return payload.response_id || payload.responseId || (payload.response && payload.response.id) || "active";
}

function getAssistantEventSource(type) {
  if (type.includes("output_audio_transcript")) {
    return "output_audio_transcript";
  }
  if (type.includes("audio_transcript")) {
    return "audio_transcript";
  }
  return "text";
}

function normalizeAssistantText(text) {
  return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function rememberAssistantCompletion(responseId, text) {
  const normalized = normalizeAssistantText(text);
  if (!normalized) {
    return;
  }

  completedAssistantResponses.add(responseId);
  recentAssistantTexts.push(normalized);
  if (recentAssistantTexts.length > 8) {
    recentAssistantTexts.shift();
  }
}

function isDuplicateAssistantCompletion(responseId, text) {
  const normalized = normalizeAssistantText(text);
  return completedAssistantResponses.has(responseId) || recentAssistantTexts.includes(normalized);
}

function setBusy(isBusy) {
  elements.startBtn.disabled = isBusy || Boolean(peerConnection);
  if (!isBusy && !peerConnection) {
    elements.startBtn.disabled = false;
  }
}

function setStatus(element, text, tone) {
  element.textContent = text;
  element.className = "status-pill";
  if (tone) {
    element.classList.add(`status-${tone}`);
  }
}

function readApiError(text) {
  try {
    const data = JSON.parse(text);
    if (data.detail) {
      return data.detail;
    }
    if (data.error) {
      return data.error;
    }
  } catch (error) {
    return text.slice(0, 300);
  }
  return "Không tạo được phiên luyện hợp lệ.";
}

function setupAudioMeter(stream) {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  drawLiveWave();
}

function drawLiveWave() {
  const canvas = elements.waveform;
  const ctx = canvas.getContext("2d");
  const buffer = new Uint8Array(analyser.frequencyBinCount);

  function frame() {
    analyser.getByteTimeDomainData(buffer);
    drawWave(buffer, true);
    animationId = requestAnimationFrame(frame);
  }

  frame();
}

function drawIdleWave() {
  const buffer = new Uint8Array(1024);
  for (let index = 0; index < buffer.length; index += 1) {
    buffer[index] = 128 + Math.sin(index / 28) * 10 + Math.sin(index / 71) * 6;
  }
  drawWave(buffer, false);
}

function drawWave(buffer, live) {
  const canvas = elements.waveform;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const middle = height / 2;

  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = live ? 3 : 2;
  ctx.strokeStyle = live ? "#0ea5e9" : "rgba(14, 165, 233, 0.38)";
  ctx.beginPath();

  const step = width / (buffer.length - 1);
  for (let index = 0; index < buffer.length; index += 1) {
    const value = (buffer[index] - 128) / 128;
    const x = index * step;
    const y = middle + value * (height * 0.36);
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }

  ctx.stroke();
  ctx.fillStyle = live ? "rgba(51, 199, 173, 0.95)" : "rgba(51, 199, 173, 0.45)";
  ctx.beginPath();
  ctx.arc(width - 36, 34, live ? 7 : 5, 0, Math.PI * 2);
  ctx.fill();
}

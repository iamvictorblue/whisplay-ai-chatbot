const statusText = document.getElementById("statusText");
const textContent = document.getElementById("textContent");
const batteryFill = document.getElementById("batteryFill");
const batteryText = document.getElementById("batteryText");
const netIcon = document.getElementById("netIcon");
const imageIcon = document.getElementById("imageIcon");
const ragIcon = document.getElementById("ragIcon");
const callerPanel = document.getElementById("callerPanel");
const calleePanel = document.getElementById("calleePanel");
const callerPortrait = document.getElementById("callerPortrait");
const calleePortrait = document.getElementById("calleePortrait");
const pttMeter = document.getElementById("pttMeter");
const pttSegments = pttMeter ? Array.from(pttMeter.querySelectorAll("span")) : [];
const freqText = document.getElementById("freqText");
const voiceState = document.getElementById("voiceState");
const led = document.getElementById("led");
const ledText = document.getElementById("ledText");
const btn = document.getElementById("btn");
const btnText = document.getElementById("btnText");
const dim = document.getElementById("dim");
const imageLayer = document.getElementById("imageLayer");
const imageDisplay = document.getElementById("imageDisplay");

let scrollTop = 0;
let scrollSpeed = 0;
let scrollTarget = null;
let scrollSyncStart = null;
let scrollSyncDuration = 0;
let scrollSyncFrom = 0;
let lastFrameTime = 0;
let maxScroll = 0;
let lastText = "";
let lastImageRevision = -1;
let isPressed = false;
let lastVoicePingAt = 0;
let currentMode = "idle";
let pttBoostUntil = 0;

let audioContext = null;
let audioUnlocked = false;
let radioInput = null;
let radioOutput = null;
let radioNoiseGain = null;
let radioNoiseSource = null;

function setIconVisible(iconEl, visible) {
  iconEl.style.display = visible ? "block" : "none";
}

function rgb565ToRgb(color) {
  const r = (color >> 11) & 0x1f;
  const g = (color >> 5) & 0x3f;
  const b = color & 0x1f;
  return [
    Math.round((r * 255) / 31),
    Math.round((g * 255) / 63),
    Math.round((b * 255) / 31),
  ];
}

function normalizeColor(value) {
  if (typeof value === "number") {
    const rgb = rgb565ToRgb(value);
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  }
  if (typeof value === "string" && value.length > 0) {
    return value.startsWith("#") ? value : `#${value}`;
  }
  return "#44f28a";
}

function loadPortraitWithFallback(img, panel, candidates) {
  if (!img || !panel || !Array.isArray(candidates) || candidates.length === 0) return;
  let index = 0;
  panel.classList.remove("missing");

  const tryNext = () => {
    if (index >= candidates.length) {
      panel.classList.add("missing");
      return;
    }
    const nextSrc = candidates[index];
    index += 1;
    img.src = nextSrc;
  };

  img.addEventListener("error", tryNext);
  img.addEventListener("load", () => {
    panel.classList.remove("missing");
  });
  tryNext();
}

function setPttLevel(level) {
  const clamped = Math.max(0, Math.min(pttSegments.length, level));
  pttSegments.forEach((segment, index) => {
    segment.classList.toggle("active", index < clamped);
  });
}

function ensureAudioContext() {
  if (audioContext) return audioContext;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  audioContext = new Ctx();
  return audioContext;
}

function ensureRadioGraph() {
  const ctx = ensureAudioContext();
  if (!ctx) return null;
  if (radioInput && radioOutput) return { ctx, input: radioInput, output: radioOutput };

  radioInput = ctx.createGain();
  const bandPass = ctx.createBiquadFilter();
  bandPass.type = "bandpass";
  bandPass.frequency.value = 1650;
  bandPass.Q.value = 1.2;

  const highPass = ctx.createBiquadFilter();
  highPass.type = "highpass";
  highPass.frequency.value = 300;

  const lowPass = ctx.createBiquadFilter();
  lowPass.type = "lowpass";
  lowPass.frequency.value = 3400;

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -28;
  compressor.knee.value = 30;
  compressor.ratio.value = 12;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.2;

  radioOutput = ctx.createGain();
  radioOutput.gain.value = 0.45;

  radioInput.connect(bandPass);
  bandPass.connect(highPass);
  highPass.connect(lowPass);
  lowPass.connect(compressor);
  compressor.connect(radioOutput);
  radioOutput.connect(ctx.destination);

  return { ctx, input: radioInput, output: radioOutput };
}

function ensureNoiseSource() {
  if (radioNoiseSource && radioNoiseGain) {
    return;
  }
  const graph = ensureRadioGraph();
  if (!graph) return;
  const { ctx, input } = graph;

  const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const channelData = noiseBuffer.getChannelData(0);
  for (let i = 0; i < channelData.length; i += 1) {
    channelData[i] = Math.random() * 2 - 1;
  }

  radioNoiseSource = ctx.createBufferSource();
  radioNoiseSource.buffer = noiseBuffer;
  radioNoiseSource.loop = true;

  radioNoiseGain = ctx.createGain();
  radioNoiseGain.gain.value = 0.00001;

  radioNoiseSource.connect(radioNoiseGain);
  radioNoiseGain.connect(input);
  radioNoiseSource.start();
}

function setRadioNoise(level) {
  if (!audioUnlocked) return;
  ensureNoiseSource();
  if (!radioNoiseGain) return;
  const ctx = ensureAudioContext();
  if (!ctx) return;
  const target = Math.max(0.00001, level);
  radioNoiseGain.gain.cancelScheduledValues(ctx.currentTime);
  radioNoiseGain.gain.setTargetAtTime(target, ctx.currentTime, 0.06);
}

function tryUnlockAudio() {
  if (audioUnlocked) return;
  const ctx = ensureAudioContext();
  if (!ctx) return;
  ctx
    .resume()
    .then(() => {
      audioUnlocked = true;
      ensureRadioGraph();
      setRadioNoise(0.00001);
    })
    .catch(() => {
      audioUnlocked = false;
    });
}

function playTone(freq, durationMs, type = "square", gain = 0.012, delaySec = 0) {
  if (!audioUnlocked) return;
  const graph = ensureRadioGraph();
  if (!graph) return;
  const { ctx, input } = graph;

  const now = ctx.currentTime + delaySec;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(90, freq), now);
  osc.frequency.exponentialRampToValueAtTime(Math.max(90, freq * 1.02), now + durationMs / 1000);

  amp.gain.setValueAtTime(0.0001, now);
  amp.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), now + 0.008);
  amp.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);

  osc.connect(amp);
  amp.connect(input);
  osc.start(now);
  osc.stop(now + durationMs / 1000 + 0.02);
}

function playConnectTone() {
  playTone(640, 45, "triangle", 0.01, 0);
  playTone(860, 45, "triangle", 0.011, 0.06);
  playTone(1070, 55, "triangle", 0.011, 0.12);
}

function playDisconnectTone() {
  playTone(560, 70, "sawtooth", 0.01, 0);
  playTone(420, 85, "sawtooth", 0.008, 0.08);
}

function playVoicePing(deltaChars) {
  const now = performance.now();
  if (now - lastVoicePingAt < 65) return;
  lastVoicePingAt = now;

  const pulses = Math.max(1, Math.min(3, Math.ceil(deltaChars / 22)));
  for (let i = 0; i < pulses; i += 1) {
    playTone(820 + Math.random() * 180, 42, "square", 0.01, i * 0.045);
  }
}

function setCodecMode(mode) {
  if (mode === currentMode) return;
  const previousMode = currentMode;
  currentMode = mode;

  callerPanel.classList.remove("active", "alert");
  calleePanel.classList.remove("active", "alert");
  voiceState.classList.remove("talking", "alert");

  if (mode === "talking") {
    calleePanel.classList.add("active");
    voiceState.textContent = "RX";
    voiceState.classList.add("talking");
    setRadioNoise(0.0042);
  } else if (mode === "listening") {
    callerPanel.classList.add("active");
    voiceState.textContent = "LISTEN";
    setRadioNoise(0.0024);
  } else if (mode === "alert") {
    callerPanel.classList.add("alert");
    calleePanel.classList.add("alert");
    voiceState.textContent = "ALERT";
    voiceState.classList.add("alert");
    setRadioNoise(0.0014);
  } else {
    voiceState.textContent = "STBY";
    setRadioNoise(0.00001);
  }

  if (mode === "talking" && previousMode !== "talking") {
    playTone(740, 36, "square", 0.008, 0);
  }
  if (previousMode === "talking" && mode !== "talking") {
    playTone(520, 30, "triangle", 0.006, 0);
  }
}

function resolveCodecMode(data, deltaChars) {
  const status = String(data?.status || "").toLowerCase();
  if (status.includes("error") || status.includes("offline") || status.includes("fail")) {
    return "alert";
  }
  if (status.includes("listen") || status.includes("wake") || status.includes("record")) {
    return "listening";
  }
  if (status.includes("speak") || status.includes("reply") || status.includes("answer") || deltaChars > 0) {
    return "talking";
  }
  return "idle";
}

function updateFrequency(mode) {
  const base = 140.85;
  let drift = 0;
  if (mode === "talking") {
    drift = (Math.random() - 0.5) * 0.08;
  } else if (mode === "listening") {
    drift = (Math.random() - 0.5) * 0.03;
  }
  freqText.textContent = (base + drift).toFixed(2);
}

function applyScrollSync(text, sync, viewportHeight) {
  if (!sync || !text) return;
  const charEnd = Math.max(0, parseInt(sync.char_end || 0, 10));
  const duration = Math.max(1, parseInt(sync.duration_ms || 1, 10));
  const totalChars = text.length || 1;
  const ratio = Math.min(1, charEnd / totalChars);
  maxScroll = Math.max(0, textContent.offsetHeight - viewportHeight);
  scrollTarget = Math.max(scrollTop, Math.round(maxScroll * ratio));
  scrollSyncFrom = scrollTop;
  scrollSyncStart = performance.now();
  scrollSyncDuration = duration;
}

function updateText(text, sync, speed) {
  const viewportHeight = document.querySelector(".text-viewport").offsetHeight;
  const nextText = text || "";
  const previousText = lastText;
  const isRegressive =
    nextText.length > 0 &&
    nextText.length < previousText.length &&
    previousText.startsWith(nextText);

  if (isRegressive) {
    scrollSpeed = Math.max(0, parseInt(speed || 0, 10));
    applyScrollSync(previousText, sync, viewportHeight);
    maxScroll = Math.max(0, textContent.offsetHeight - viewportHeight);
    return 0;
  }

  let deltaChars = 0;
  if (nextText !== previousText) {
    const isContinuation = nextText.startsWith(previousText);
    textContent.textContent = nextText;
    if (!isContinuation) {
      scrollTop = 0;
      scrollTarget = null;
      scrollSyncStart = null;
      scrollSyncDuration = 0;
      scrollSyncFrom = 0;
    }
    deltaChars = isContinuation ? nextText.length - previousText.length : Math.min(nextText.length, 50);
    lastText = nextText;
  }

  scrollSpeed = Math.max(0, parseInt(speed || 0, 10));
  applyScrollSync(lastText, sync, viewportHeight);
  maxScroll = Math.max(0, textContent.offsetHeight - viewportHeight);
  return deltaChars;
}

function animateScroll(timestamp) {
  if (!lastFrameTime) {
    lastFrameTime = timestamp;
  }
  const deltaMs = timestamp - lastFrameTime;
  lastFrameTime = timestamp;

  if (scrollTarget !== null && scrollSyncStart !== null) {
    const elapsed = timestamp - scrollSyncStart;
    const progress = Math.min(1, elapsed / scrollSyncDuration);
    scrollTop = scrollSyncFrom + (scrollTarget - scrollSyncFrom) * progress;
    if (progress >= 1) {
      scrollTarget = null;
      scrollSyncStart = null;
    }
  } else if (scrollSpeed > 0 && scrollTop < maxScroll) {
    const speedPerSec = scrollSpeed * 5;
    scrollTop = Math.min(maxScroll, scrollTop + (speedPerSec * deltaMs) / 1000);
  }

  textContent.style.transform = `translateY(${-scrollTop}px)`;

  const baseLevel =
    currentMode === "talking" ? 6 : currentMode === "listening" ? 4 : currentMode === "alert" ? 1 : 2;
  const wave = currentMode === "talking" ? Math.floor((Math.sin(timestamp / 55) + 1) * 1.7) : 0;
  const boost = performance.now() < pttBoostUntil ? 2 : 0;
  setPttLevel(baseLevel + wave + boost);

  requestAnimationFrame(animateScroll);
}

let ws = null;
let reconnectTimer = null;
let cameraTimer = null;

function applyState(data) {
  if (!data || !data.ready) return;

  statusText.textContent = data.status || "standby";
  const deltaChars = updateText(data.text || "", data.scroll_sync, data.scroll_speed);
  const mode = resolveCodecMode(data, deltaChars);
  setCodecMode(mode);
  updateFrequency(mode);

  if (deltaChars > 0) {
    pttBoostUntil = performance.now() + 180;
    playVoicePing(deltaChars);
  }

  const ledColor = normalizeColor(data.RGB);
  led.style.background = ledColor;
  led.style.boxShadow = `0 0 24px ${ledColor}`;
  ledText.textContent = ledColor;

  const batteryLevel = typeof data.battery_level === "number" ? data.battery_level : null;
  if (batteryLevel === null) {
    batteryText.textContent = "--%";
    batteryFill.style.width = "0%";
  } else {
    batteryText.textContent = `${batteryLevel}%`;
    batteryFill.style.width = `${Math.min(100, Math.max(0, batteryLevel))}%`;
  }
  batteryFill.style.background = normalizeColor(data.battery_color);

  setIconVisible(netIcon, Boolean(data.network_connected));
  setIconVisible(imageIcon, Boolean(data.image_icon_visible));
  setIconVisible(ragIcon, Boolean(data.rag_icon_visible));

  const dimOpacity = Math.max(0, Math.min(1, (100 - (data.brightness ?? 100)) / 100));
  dim.style.opacity = dimOpacity.toFixed(2);

  if (data.camera_mode) {
    imageLayer.style.display = "flex";
    startCameraFeed();
    return;
  }

  stopCameraFeed();
  if (data.image && data.image_revision !== lastImageRevision) {
    lastImageRevision = data.image_revision;
    imageDisplay.src = `/image?rev=${lastImageRevision}`;
    imageLayer.style.display = "flex";
  } else if (!data.image) {
    imageLayer.style.display = "none";
  }
}

function startCameraFeed() {
  if (cameraTimer) return;
  cameraTimer = setInterval(() => {
    imageDisplay.src = `/camera?ts=${Date.now()}`;
  }, 200);
}

function stopCameraFeed() {
  if (!cameraTimer) return;
  clearInterval(cameraTimer);
  cameraTimer = null;
}

function connectWebSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const url = `${protocol}://${window.location.host}/ws`;
  ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    setCodecMode("idle");
    updateFrequency("idle");
    playConnectTone();
  });

  ws.addEventListener("message", (event) => {
    let message = null;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "state") {
      applyState(message.payload);
    }
  });

  ws.addEventListener("close", () => {
    stopCameraFeed();
    setCodecMode("alert");
    playDisconnectTone();
    reconnectTimer = setTimeout(connectWebSocket, 1000);
  });

  ws.addEventListener("error", () => {
    ws.close();
  });
}

function sendButton(action) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "button", action }));
}

function setPressed(value) {
  isPressed = value;
  btnText.textContent = isPressed ? "pressed" : "released";
}

const press = () => {
  tryUnlockAudio();
  setPressed(true);
  sendButton("press");
};

const release = () => {
  if (!isPressed) return;
  setPressed(false);
  sendButton("release");
};

loadPortraitWithFallback(callerPortrait, callerPanel, [
  "/img/MGS_PS1-Topless-snake.png",
  "/img/codec-caller.png",
  "/img/caller.png",
  "/img/logo.png",
]);
loadPortraitWithFallback(calleePortrait, calleePanel, [
  "/img/MGS_PS1-Ocaton-final.png",
  "/img/codec-callee.png",
  "/img/callee.png",
  "/img/logo.png",
]);

connectWebSocket();
requestAnimationFrame(animateScroll);
setCodecMode("idle");
updateFrequency("idle");

window.addEventListener("pointerdown", tryUnlockAudio);
window.addEventListener("touchstart", tryUnlockAudio);
window.addEventListener("keydown", tryUnlockAudio);

btn.addEventListener("mousedown", press);
btn.addEventListener("mouseup", release);
btn.addEventListener("mouseleave", release);
window.addEventListener("mouseup", release);
btn.addEventListener("touchstart", (event) => {
  event.preventDefault();
  press();
});
btn.addEventListener("touchend", (event) => {
  event.preventDefault();
  release();
});
window.addEventListener("touchend", release);

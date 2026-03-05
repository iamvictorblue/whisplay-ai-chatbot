import mp3Duration from "mp3-duration";
import { openai } from "./openai"; // Assuming openai is exported from openai.ts
import dotenv from "dotenv";
import { TTSResult } from "../../type";

dotenv.config();

const lowLatencyMode = (process.env.LOW_LATENCY_MODE || "false").toLowerCase() === "true";
const otaconModeEnabled = (process.env.OTACON_MODE || "true").toLowerCase() === "true";
const defaultVoiceType = otaconModeEnabled ? "fable" : "onyx";
const defaultVoiceSpeed = lowLatencyMode
  ? otaconModeEnabled
    ? "1.06"
    : "1.02"
  : otaconModeEnabled
    ? "0.98"
    : "0.92";
const defaultVoiceModel = lowLatencyMode ? "tts-1" : "tts-1-hd";

const openAiVoiceType = process.env.OPENAI_VOICE_TYPE || defaultVoiceType; // Optional: alloy, echo, fable, onyx, nova, shimmer
const openAiVoiceSpeedRaw = process.env.OPENAI_VOICE_SPEED || defaultVoiceSpeed;
const openAiVoiceSpeed = Number.parseFloat(openAiVoiceSpeedRaw);
const normalizedVoiceSpeed =
  Number.isFinite(openAiVoiceSpeed) && openAiVoiceSpeed >= 0.25 && openAiVoiceSpeed <= 4
    ? openAiVoiceSpeed
    : Number.parseFloat(defaultVoiceSpeed);
const normalizedVoiceModel = process.env.OPENAI_VOICE_MODEL || defaultVoiceModel;

const openaiTTS = async (
  text: string
): Promise<TTSResult> => {
  if (!openai) {
    console.error("OpenAI API key is not set.");
    return { duration: 0 };
  }
  const mp3 = await openai.audio.speech.create({
    model: normalizedVoiceModel,
    voice: openAiVoiceType,
    input: text,
    speed: normalizedVoiceSpeed,
  }).catch((error) => {
    console.log("OpenAI TTS failed:", error);
    return null;
  });
  if (!mp3) {
    return { duration: 0 };
  }
  const buffer = Buffer.from(await mp3.arrayBuffer());
  const duration = await mp3Duration(buffer);
  return { buffer, duration: duration * 1000 };
};

export default openaiTTS;

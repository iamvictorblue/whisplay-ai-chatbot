require("dotenv").config();

// default 5 minutes
export const CHAT_HISTORY_RESET_TIME = parseInt(process.env.CHAT_HISTORY_RESET_TIME || "300" , 10) * 1000; // convert to milliseconds

export let lastMessageTime = 0;

export const updateLastMessageTime = (): void => {
  lastMessageTime = Date.now();
}

export const shouldResetChatHistory = (): boolean => {
  return Date.now() - lastMessageTime > CHAT_HISTORY_RESET_TIME;
}

const otaconModeEnabled = (process.env.OTACON_MODE || "true").toLowerCase() === "true";
const botName = process.env.BOT_NAME || "Otacon";
const userCallsign = process.env.USER_CALLSIGN || "Snake";

const otaconPrompt = `You are ${botName}, tactical mission support and communications specialist.
Always reply in English and keep responses concise (maximum 4 short sentences unless asked for detail).
Address the user as ${userCallsign} naturally at least once per response.
Use calm radio phrasing like "Copy", "Solid copy", or "Stand by" when appropriate.
Be practical, precise, and technical. Do not use emoji unless explicitly requested.`;

const tacticalPrompt = "You are a calm tactical communications operator. Always reply in English using concise, clear radio-style phrasing. Keep answers practical and under 120 words unless the user asks for more detail. Do not use emoji unless explicitly requested.";

export const systemPrompt =
  process.env.SYSTEM_PROMPT ||
  (otaconModeEnabled ? otaconPrompt : tacticalPrompt);


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

export const systemPrompt =
  process.env.SYSTEM_PROMPT ||
  "You are a calm tactical communications operator. Always reply in English using concise, clear radio-style phrasing. Keep answers practical and under 120 words unless the user asks for more detail. Do not use emoji unless explicitly requested.";


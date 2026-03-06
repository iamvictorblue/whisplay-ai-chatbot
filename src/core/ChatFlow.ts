import {
  getCurrentTimeTag,
  getRecordFileDurationMs,
  splitSentences,
} from "./../utils/index";
import { display } from "../device/display";
import { recognizeAudio, ttsProcessor } from "../cloud-api/server";
import { isImMode } from "../cloud-api/llm";
import { extractEmojis } from "../utils";
import { StreamResponser } from "./StreamResponsor";
import { dataDir, recordingsDir } from "../utils/dir";
import dotEnv from "dotenv";
import { WakeWordListener } from "../device/wakeword";
import { WhisplayIMBridgeServer } from "../device/im-bridge";
import { FlowStateMachine } from "./chat-flow/stateMachine";
import { flowStates } from "./chat-flow/states";
import { ChatFlowContext, FlowName } from "./chat-flow/types";
import {
  playCodecAlertSound,
  playCodecTriggerSound,
  playWakeupChime,
} from "../device/audio";
import { parseLocalCommand } from "./local-commands";
import { ReminderStore } from "./reminder-store";

dotEnv.config();

const MGS_FACT_POOL: string[] = [
  "the original Metal Gear launched on MSX2 in 1987 and established stealth as the core idea.",
  "Metal Gear Solid released on PlayStation in 1998 and pushed cinematic storytelling in console games.",
  "Solid Snake's support operator Otacon is Dr. Hal Emmerich.",
  "Shadow Moses, the setting of Metal Gear Solid, is a remote Alaskan island nuclear facility.",
  "Metal Gear REX was designed as a bipedal nuclear weapons platform.",
  "the series made the cardboard box one of gaming's most iconic stealth tools.",
  "the CODEC in Metal Gear Solid is a low-visibility communication system used during infiltration.",
  "MGS alert phases are classically split into Alert, Evasion, and Caution before returning to normal.",
  "FOXHOUND is the special operations unit central to multiple key events in the series.",
  "Hideo Kojima directed and wrote major entries that defined the franchise tone.",
  "Metal Gear Solid 2 switched protagonists for most of the story, which became one of gaming's famous twists.",
  "many boss encounters in Metal Gear are designed as character-driven stories, not just combat checks.",
];

class ChatFlow implements ChatFlowContext {
  currentFlowName: FlowName = "sleep";
  recordingsDir: string = "";
  currentRecordFilePath: string = "";
  asrText: string = "";
  streamResponser: StreamResponser;
  partialThinking: string = "";
  thinkingSentences: string[] = [];
  answerId: number = 0;
  enableCamera: boolean = false;
  knowledgePrompts: string[] = [];
  wakeWordListener: WakeWordListener | null = null;
  wakeSessionActive: boolean = false;
  wakeSessionStartAt: number = 0;
  wakeSessionLastSpeechAt: number = 0;
  wakeSessionIdleTimeoutMs: number =
    parseInt(process.env.WAKE_WORD_IDLE_TIMEOUT_SEC || "60") * 1000;
  wakeRecordMaxSec: number = parseInt(
    process.env.WAKE_WORD_RECORD_MAX_SEC || "60",
  );
  wakeEndKeywords: string[] = (process.env.WAKE_WORD_END_KEYWORDS || "byebye,goodbye,stop,byebye").toLowerCase()
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  endAfterAnswer: boolean = false;
  whisplayIMBridge: WhisplayIMBridgeServer | null = null;
  pendingExternalReply: string = "";
  pendingExternalEmoji: string = "";
  currentExternalEmoji: string = "";
  stateMachine: FlowStateMachine;
  isFromWakeListening: boolean = false;
  lowLatencyMode: boolean =
    (process.env.LOW_LATENCY_MODE || "false").toLowerCase() === "true";
  externalReplyChunkDelayMs: number = parseInt(
    process.env.EXTERNAL_REPLY_CHUNK_DELAY_MS || "0",
    10,
  );
  mgsFactsEnabled: boolean =
    (process.env.MGS_FACTS_ENABLED || "true").toLowerCase() === "true";
  mgsFactsMinMs: number = Math.max(
    60_000,
    parseInt(process.env.MGS_FACTS_MIN_MINUTES || "12", 10) * 60_000,
  );
  mgsFactsMaxMs: number = Math.max(
    Math.max(60_000, parseInt(process.env.MGS_FACTS_MIN_MINUTES || "12", 10) * 60_000),
    parseInt(process.env.MGS_FACTS_MAX_MINUTES || "28", 10) * 60_000,
  );
  mgsFactsTimer: NodeJS.Timeout | null = null;
  lastMgsFactIndex: number = -1;
  reminderStorePath: string =
    process.env.REMINDER_STORE_PATH || `${dataDir}/reminders.json`;
  reminderStoreMaxItems: number = Math.max(
    1,
    parseInt(process.env.REMINDER_STORE_MAX_ITEMS || "120", 10),
  );
  reminderStore: ReminderStore;
  missionDefaultMinutes: number = Math.max(
    1,
    parseInt(process.env.MISSION_DEFAULT_MINUTES || "25", 10),
  );
  missionBreakMinutes: number = Math.max(
    1,
    parseInt(process.env.MISSION_BREAK_MINUTES || "5", 10),
  );
  missionMaxMinutes: number = Math.max(
    1,
    parseInt(process.env.MISSION_MAX_MINUTES || "180", 10),
  );
  missionFocusMinutes: number = this.missionDefaultMinutes;
  missionPhase: "idle" | "focus" | "break" = "idle";
  missionPaused: boolean = false;
  missionEndsAt: number = 0;
  missionRemainingMs: number = 0;
  missionRound: number = 0;
  missionTimer: NodeJS.Timeout | null = null;
  systemReplyQueue: Array<{ text: string; alert: boolean; trigger: boolean }> =
    [];
  isDispatchingSystemReply: boolean = false;

  constructor(options: { enableCamera?: boolean } = {}) {
    console.log(`[${getCurrentTimeTag()}] ChatBot started.`);
    this.recordingsDir = recordingsDir;
    this.reminderStore = new ReminderStore(
      this.reminderStorePath,
      this.reminderStoreMaxItems,
    );
    this.stateMachine = new FlowStateMachine(this, flowStates);
    this.streamResponser = new StreamResponser(
      ttsProcessor,
      (sentences: string[]) => {
        if (!this.isAnswerFlow()) return;
        const fullText = sentences.join(" ");
        let emoji = "😐";
        if (this.currentFlowName === "external_answer") {
          emoji = this.currentExternalEmoji || extractEmojis(fullText) || emoji;
        } else {
          emoji = extractEmojis(fullText) || emoji;
        }
        display({
          status: "answering",
          emoji,
          text: fullText,
          RGB: "#0000ff",
          scroll_speed: 3,
        });
      },
      (text: string) => {
        if (!this.isAnswerFlow()) return;
        display({
          status: "answering",
          text: text || undefined,
          scroll_speed: 3,
        });
      },
      ({ charEnd, durationMs }) => {
        if (!this.isAnswerFlow()) return;
        if (!durationMs || durationMs <= 0) return;
        display({
          scroll_sync: {
            char_end: charEnd,
            duration_ms: durationMs,
          },
        });
      }
    );
    if (options?.enableCamera) {
      this.enableCamera = true;
    }

    this.transitionTo("sleep");

    const wakeEnabled = (process.env.WAKE_WORD_ENABLED || "").toLowerCase();
    if (wakeEnabled === "true") {
      this.wakeWordListener = new WakeWordListener();
      this.wakeWordListener.on("wake", () => {
        if (this.currentFlowName === "sleep") {
          this.startWakeSession();
        }
      });
      this.wakeWordListener.start();
    }

    if (isImMode) {
      this.whisplayIMBridge = new WhisplayIMBridgeServer();
      this.whisplayIMBridge.on(
        "reply",
        (payload: { reply: string; emoji?: string }) => {
          this.pendingExternalReply = payload.reply;
          this.pendingExternalEmoji = payload.emoji || "";
          this.transitionTo("external_answer");
        },
      );
      this.whisplayIMBridge.start();
    }

    if (this.mgsFactsEnabled && !isImMode) {
      this.scheduleNextMgsFact();
    }
  }

  async recognizeAudio(path: string, isFromAutoListening?: boolean): Promise<string> {
    if (!isFromAutoListening && (await getRecordFileDurationMs(path)) < 500) {
      console.log("Record audio too short, skipping recognition.");
      return Promise.resolve("");
    }
    console.time(`[ASR time]`);
    const result = await recognizeAudio(path);
    console.timeEnd(`[ASR time]`);
    return result;
  }

  partialThinkingCallback = (partialThinking: string): void => {
    this.partialThinking += partialThinking;
    const { sentences, remaining } = splitSentences(this.partialThinking);
    if (sentences.length > 0) {
      this.thinkingSentences.push(...sentences);
      const displayText = this.thinkingSentences.join(" ");
      display({
        status: "Thinking",
        emoji: "🤔",
        text: displayText,
        RGB: "#ff6800", // yellow
        scroll_speed: 6,
      });
    }
    this.partialThinking = remaining;
  };

  transitionTo = (flowName: FlowName): void => {
    console.log(`[${getCurrentTimeTag()}] switch to:`, flowName);
    this.stateMachine.transitionTo(flowName);
    if (flowName === "sleep") {
      setTimeout(() => this.flushSystemReplyQueue(), 20);
    }
  };

  isAnswerFlow = (): boolean => {
    return (
      this.currentFlowName === "answer" ||
      this.currentFlowName === "external_answer"
    );
  };

  streamExternalReply = async (text: string, emoji?: string): Promise<void> => {
    if (!text) {
      this.streamResponser.endPartial();
      return;
    }
    if (emoji) {
      display({
        status: "answering",
        emoji,
        scroll_speed: 3,
      });
    }
    const { sentences, remaining } = splitSentences(text);
    const parts = [...sentences];
    if (remaining.trim()) {
      parts.push(remaining);
    }
    for (const part of parts) {
      this.streamResponser.partial(part);
      const chunkDelay =
        this.externalReplyChunkDelayMs > 0
          ? this.externalReplyChunkDelayMs
          : this.lowLatencyMode
            ? 40
            : 120;
      await new Promise((resolve) => setTimeout(resolve, chunkDelay));
    }
    this.streamResponser.endPartial();
  };

  startWakeSession = (): void => {
    this.wakeSessionActive = true;
    this.wakeSessionStartAt = Date.now();
    this.wakeSessionLastSpeechAt = this.wakeSessionStartAt;
    this.endAfterAnswer = false;
    playWakeupChime();
    this.transitionTo("wake_listening");
  };

  endWakeSession = (): void => {
    this.wakeSessionActive = false;
    this.endAfterAnswer = false;
  };

  shouldContinueWakeSession = (): boolean => {
    if (!this.wakeSessionActive) return false;
    const last = this.wakeSessionLastSpeechAt || this.wakeSessionStartAt;
    return Date.now() - last < this.wakeSessionIdleTimeoutMs;
  };

  shouldEndAfterAnswer = (text: string): boolean => {
    const lower = text.toLowerCase();
    return this.wakeEndKeywords.some(
      (keyword) => keyword && lower.includes(keyword),
    );
  };

  handleLocalCommand = async (text: string): Promise<boolean> => {
    const command = parseLocalCommand(text);
    if (!command) {
      return false;
    }
    console.log("[LocalCommand] Parsed:", command);

    switch (command.type) {
      case "add_reminder": {
        const result = this.reminderStore.add(command.text);
        if (!result.ok) {
          if (result.reason === "limit") {
            await this.sendImmediateLocalReply(
              `Snake, reminder storage is full at ${this.reminderStoreMaxItems}. Delete one before adding more.`,
              {},
            );
            return true;
          }
          await this.sendImmediateLocalReply(
            "Snake, reminder text was empty. Say remind me to followed by the task.",
            {},
          );
          return true;
        }
        const total = this.reminderStore.getAll().length;
        await this.sendImmediateLocalReply(
          `Snake, reminder saved as item ${total}.`,
          {},
        );
        return true;
      }
      case "list_reminders": {
        await this.sendImmediateLocalReply(this.buildReminderListReply(), {});
        return true;
      }
      case "delete_reminder": {
        const result = this.reminderStore.deleteByIndex(command.index);
        if (!result.ok) {
          await this.sendImmediateLocalReply(
            `Snake, reminder ${command.index} was not found.`,
            {},
          );
          return true;
        }
        await this.sendImmediateLocalReply(
          `Snake, deleted reminder ${command.index}.`,
          {},
        );
        return true;
      }
      case "clear_reminders": {
        const removed = this.reminderStore.clear();
        await this.sendImmediateLocalReply(
          removed > 0
            ? `Snake, cleared ${removed} reminders.`
            : "Snake, reminder list is already empty.",
          {},
        );
        return true;
      }
      case "start_mission": {
        const requestedMinutes = command.minutes ?? this.missionDefaultMinutes;
        if (requestedMinutes <= 0 || requestedMinutes > this.missionMaxMinutes) {
          await this.sendImmediateLocalReply(
            `Snake, mission time must be between 1 and ${this.missionMaxMinutes} minutes.`,
            {},
          );
          return true;
        }
        const restarted = this.missionPhase !== "idle" || this.missionPaused;
        this.missionFocusMinutes = requestedMinutes;
        this.missionRound = 1;
        this.missionPaused = false;
        this.startMissionPhase("focus", requestedMinutes * 60_000);
        await this.sendImmediateLocalReply(
          restarted
            ? `Snake, mission reset. Focus window is now ${requestedMinutes} minutes.`
            : `Snake, mission started for ${requestedMinutes} minutes.`,
          { trigger: true },
        );
        return true;
      }
      case "pause_mission": {
        if (this.missionPhase === "idle") {
          await this.sendImmediateLocalReply(
            "Snake, there is no active mission to pause.",
            {},
          );
          return true;
        }
        if (this.missionPaused) {
          await this.sendImmediateLocalReply(
            "Snake, mission is already paused.",
            {},
          );
          return true;
        }
        this.clearMissionTimer();
        this.missionRemainingMs = Math.max(1000, this.missionEndsAt - Date.now());
        this.missionPaused = true;
        await this.sendImmediateLocalReply(
          `Snake, mission paused with ${this.formatDuration(this.missionRemainingMs)} remaining in ${this.missionPhase} phase.`,
          {},
        );
        return true;
      }
      case "resume_mission": {
        if (this.missionPhase === "idle") {
          await this.sendImmediateLocalReply(
            "Snake, there is no active mission to resume.",
            {},
          );
          return true;
        }
        if (!this.missionPaused) {
          await this.sendImmediateLocalReply(
            "Snake, mission is already running.",
            {},
          );
          return true;
        }
        this.missionPaused = false;
        this.startMissionPhase(this.missionPhase, this.missionRemainingMs);
        await this.sendImmediateLocalReply(
          `Snake, mission resumed. ${this.formatDuration(this.missionRemainingMs)} remaining in ${this.missionPhase} phase.`,
          {},
        );
        return true;
      }
      case "mission_status": {
        await this.sendImmediateLocalReply(this.getMissionStatusReply(), {});
        return true;
      }
      case "abort_mission": {
        if (this.missionPhase === "idle") {
          await this.sendImmediateLocalReply(
            "Snake, there is no active mission to abort.",
            {},
          );
          return true;
        }
        this.stopMission();
        await this.sendImmediateLocalReply(
          "Snake, mission aborted. Standing by.",
          {},
        );
        return true;
      }
      default:
        return false;
    }
  };

  private buildReminderListReply = (): string => {
    const reminders = this.reminderStore.getAll();
    if (reminders.length === 0) {
      return "Snake, you currently have no reminders.";
    }
    const maxRead = 8;
    const lines = reminders.slice(0, maxRead).map((item, index) => {
      return `${index + 1}. ${item}`;
    });
    if (reminders.length > maxRead) {
      lines.push(`Plus ${reminders.length - maxRead} more reminders.`);
    }
    return `Snake, your reminders are: ${lines.join(" ")}`;
  };

  private formatDuration = (ms: number): string => {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes <= 0) {
      return `${seconds} seconds`;
    }
    if (seconds === 0) {
      return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    }
    return `${minutes} minute${minutes === 1 ? "" : "s"} ${seconds} second${seconds === 1 ? "" : "s"}`;
  };

  private getMissionStatusReply = (): string => {
    if (this.missionPhase === "idle") {
      return "Snake, no mission timer is active.";
    }
    const remainingMs = this.missionPaused
      ? this.missionRemainingMs
      : Math.max(0, this.missionEndsAt - Date.now());
    const phaseLabel = this.missionPhase === "focus" ? "focus" : "break";
    const pauseLabel = this.missionPaused ? "paused" : "running";
    return `Snake, mission is ${pauseLabel} in ${phaseLabel} phase with ${this.formatDuration(remainingMs)} remaining.`;
  };

  private clearMissionTimer = (): void => {
    if (this.missionTimer) {
      clearTimeout(this.missionTimer);
      this.missionTimer = null;
    }
  };

  private stopMission = (): void => {
    this.clearMissionTimer();
    this.missionPhase = "idle";
    this.missionPaused = false;
    this.missionEndsAt = 0;
    this.missionRemainingMs = 0;
    this.missionRound = 0;
  };

  private startMissionPhase = (phase: "focus" | "break", durationMs: number): void => {
    const safeDuration = Math.max(1000, durationMs);
    this.clearMissionTimer();
    this.missionPhase = phase;
    this.missionPaused = false;
    this.missionRemainingMs = safeDuration;
    this.missionEndsAt = Date.now() + safeDuration;
    this.missionTimer = setTimeout(() => {
      void this.handleMissionPhaseCompleted(phase);
    }, safeDuration);
  };

  private handleMissionPhaseCompleted = async (
    completedPhase: "focus" | "break",
  ): Promise<void> => {
    if (this.missionPaused || this.missionPhase !== completedPhase) {
      return;
    }
    if (completedPhase === "focus") {
      const breakMs = this.missionBreakMinutes * 60_000;
      this.startMissionPhase("break", breakMs);
      this.enqueueSystemReply(
        `Snake, focus phase complete. Entering break for ${this.missionBreakMinutes} minutes.`,
        { alert: true },
      );
      return;
    }
    this.missionRound += 1;
    const focusMs = this.missionFocusMinutes * 60_000;
    this.startMissionPhase("focus", focusMs);
    this.enqueueSystemReply(
      `Snake, break complete. Mission round ${this.missionRound} starts now. Focus for ${this.missionFocusMinutes} minutes.`,
      { alert: true },
    );
  };

  private enqueueSystemReply = (
    text: string,
    options: { alert?: boolean; trigger?: boolean } = {},
  ): void => {
    this.systemReplyQueue.push({
      text,
      alert: Boolean(options.alert),
      trigger: Boolean(options.trigger),
    });
    this.flushSystemReplyQueue();
  };

  private flushSystemReplyQueue = (): void => {
    if (this.isDispatchingSystemReply) {
      return;
    }
    if (
      this.currentFlowName !== "sleep" ||
      this.wakeSessionActive ||
      this.pendingExternalReply ||
      this.systemReplyQueue.length === 0
    ) {
      return;
    }
    const next = this.systemReplyQueue.shift();
    if (!next) {
      return;
    }
    this.isDispatchingSystemReply = true;
    void this.dispatchSystemReply(next).finally(() => {
      this.isDispatchingSystemReply = false;
      if (this.currentFlowName === "sleep") {
        setTimeout(() => this.flushSystemReplyQueue(), 20);
      }
    });
  };

  private dispatchSystemReply = async (payload: {
    text: string;
    alert: boolean;
    trigger: boolean;
  }): Promise<void> => {
    if (
      this.currentFlowName !== "sleep" ||
      this.wakeSessionActive ||
      this.pendingExternalReply
    ) {
      this.systemReplyQueue.unshift(payload);
      return;
    }

    if (payload.trigger) {
      await playCodecTriggerSound();
    }
    if (payload.alert) {
      await playCodecAlertSound();
    }

    if (
      this.currentFlowName !== "sleep" ||
      this.wakeSessionActive ||
      this.pendingExternalReply
    ) {
      this.systemReplyQueue.unshift(payload);
      return;
    }

    this.pendingExternalReply = payload.text;
    this.pendingExternalEmoji = "";
    this.currentExternalEmoji = "";
    this.transitionTo("external_answer");
  };

  private sendImmediateLocalReply = async (
    text: string,
    options: { alert?: boolean; trigger?: boolean } = {},
  ): Promise<void> => {
    if (options.trigger) {
      await playCodecTriggerSound();
    }
    if (options.alert) {
      await playCodecAlertSound();
    }
    this.pendingExternalReply = text;
    this.pendingExternalEmoji = "";
    this.currentExternalEmoji = "";
    this.transitionTo("external_answer");
  };

  private getNextMgsFactDelayMs = (): number => {
    const span = this.mgsFactsMaxMs - this.mgsFactsMinMs;
    if (span <= 0) {
      return this.mgsFactsMinMs;
    }
    return this.mgsFactsMinMs + Math.floor(Math.random() * (span + 1));
  };

  private pickRandomMgsFact = (): string => {
    if (MGS_FACT_POOL.length === 0) {
      return "mission support channel is standing by.";
    }
    if (MGS_FACT_POOL.length === 1) {
      this.lastMgsFactIndex = 0;
      return MGS_FACT_POOL[0];
    }
    let index = this.lastMgsFactIndex;
    while (index === this.lastMgsFactIndex) {
      index = Math.floor(Math.random() * MGS_FACT_POOL.length);
    }
    this.lastMgsFactIndex = index;
    return MGS_FACT_POOL[index];
  };

  private scheduleNextMgsFact = (): void => {
    if (!this.mgsFactsEnabled) {
      return;
    }
    if (this.mgsFactsTimer) {
      clearTimeout(this.mgsFactsTimer);
    }
    const delayMs = this.getNextMgsFactDelayMs();
    this.mgsFactsTimer = setTimeout(() => {
      void this.triggerMgsFactBroadcast().finally(() => {
        this.scheduleNextMgsFact();
      });
    }, delayMs);
  };

  private triggerMgsFactBroadcast = async (): Promise<void> => {
    if (
      this.currentFlowName !== "sleep" ||
      this.wakeSessionActive ||
      this.pendingExternalReply
    ) {
      return;
    }
    const fact = this.pickRandomMgsFact();
    await playCodecAlertSound();

    if (
      this.currentFlowName !== "sleep" ||
      this.wakeSessionActive ||
      this.pendingExternalReply
    ) {
      return;
    }

    this.pendingExternalReply = `Snake, intel update: ${fact}`;
    this.pendingExternalEmoji = "";
    this.currentExternalEmoji = "";
    this.transitionTo("external_answer");
  };
}

export default ChatFlow;

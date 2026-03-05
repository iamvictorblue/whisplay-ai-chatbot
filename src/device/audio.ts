import { spawn, ChildProcess } from "child_process";
import { isEmpty, noop } from "lodash";
import dotenv from "dotenv";
import { ttsServer, asrServer } from "../cloud-api/server";
import { pluginRegistry } from "../plugin";
import type { ASRPlugin, TTSPlugin, AudioFormat } from "../plugin";
import { ASRServer, TTSResult, TTSServer } from "../type";

export { getDynamicVoiceDetectLevel } from "./voice-detect";

dotenv.config();

const soundCardIndex = process.env.SOUND_CARD_INDEX || "1";
const alsaOutputDevice = `hw:${soundCardIndex},0`;
const normalizeAudioFormat = (value: string | undefined, fallback: AudioFormat): AudioFormat => {
  const normalized = (value || "").toLowerCase();
  return normalized === "wav" || normalized === "mp3" ? normalized : fallback;
};

const defaultTtsAudioFormat: AudioFormat = [TTSServer.gemini, TTSServer.piper].includes(ttsServer)
  ? "wav"
  : "mp3";

const selectedTtsPlugin = pluginRegistry.getPlugin("tts", ttsServer) as TTSPlugin | undefined;
const ttsAudioFormat: AudioFormat = normalizeAudioFormat(
  selectedTtsPlugin?.audioFormat,
  defaultTtsAudioFormat,
);

const useWavPlayer = ttsAudioFormat === "wav";
const codecAudioFxEnabled =
  (process.env.CODEC_AUDIO_FX || "true").toLowerCase() === "true";
const codecSfxEnabled =
  (process.env.CODEC_SFX_ENABLED || "true").toLowerCase() === "true";

const defaultAsrAudioFormat: AudioFormat = [
  ASRServer.vosk,
  ASRServer.whisper,
  ASRServer.whisperhttp,
  ASRServer.fasterwhisper,
  ASRServer.llm8850whisper,
].includes(asrServer)
  ? "wav"
  : "mp3";

const selectedAsrPlugin = pluginRegistry.getPlugin("asr", asrServer) as ASRPlugin | undefined;

export const recordFileFormat: AudioFormat = normalizeAudioFormat(
  selectedAsrPlugin?.audioFormat,
  defaultAsrAudioFormat,
);

function startPlayerProcess() {
  if (useWavPlayer) {
    return null;
  } else {
    // use mpg123 for mp3 files
    return spawn("mpg123", [
      "-",
      "--scale",
      "2",
      "-o",
      "alsa",
      "-a",
      alsaOutputDevice,
    ]);
  }
}

const getCodecVoiceEffects = (): string[] => [
  "highpass",
  "280",
  "lowpass",
  "3200",
  "compand",
  "0.02,0.10",
  "6:-70,-60,-20",
  "-5",
  "-90",
  "0.15",
  "gain",
  "-4",
];

const runSoxCommand = (
  args: string[],
  timeoutMs: number = 2200,
): Promise<void> => {
  return new Promise((resolve) => {
    let timeout: NodeJS.Timeout | null = null;
    let finished = false;
    const done = () => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      resolve();
    };
    const process = spawn("sox", args);
    process.on("error", done);
    process.on("exit", done);
    timeout = setTimeout(() => {
      try {
        process.kill("SIGTERM");
      } catch {}
      done();
    }, timeoutMs);
  });
};

const playSoxSynth = (args: string[], timeoutMs: number = 2200): Promise<void> => {
  if (!codecSfxEnabled) {
    return Promise.resolve();
  }
  return runSoxCommand(["-n", "-t", "alsa", alsaOutputDevice, ...args], timeoutMs);
};

let recordingProcessList: ChildProcess[] = [];
let currentRecordingReject: (reason?: any) => void = noop;

const killAllRecordingProcesses = (): void => {
  recordingProcessList.forEach((child) => {
    console.log("Killing recording process", child.pid);
    try {
      child.kill("SIGINT");
    } catch (e) { }
  });
  recordingProcessList.length = 0;
};

export const playWakeupChime = (): Promise<void> => {
  return playCodecConnectChirp();
};

export const playCodecConnectChirp = (): Promise<void> => {
  return playSoxSynth(
    [
      "synth",
      "0.05",
      "sine",
      "640",
      "vol",
      "0.35",
      ":",
      "synth",
      "0.05",
      "sine",
      "910",
      "vol",
      "0.3",
      ":",
      "synth",
      "0.05",
      "sine",
      "1180",
      "vol",
      "0.24",
      "fade",
      "q",
      "0.01",
      "0.18",
      "0.03",
      "highpass",
      "350",
      "lowpass",
      "3200",
      "gain",
      "-22",
    ],
    1600,
  );
};

export const playCodecPttDown = (): Promise<void> => {
  return playSoxSynth(
    [
      "synth",
      "0.025",
      "square",
      "2200",
      "vol",
      "0.22",
      "fade",
      "q",
      "0.002",
      "0.03",
      "0.01",
      "highpass",
      "550",
      "lowpass",
      "4200",
      "gain",
      "-24",
    ],
    900,
  );
};

export const playCodecPttUp = (): Promise<void> => {
  return playSoxSynth(
    [
      "synth",
      "0.02",
      "square",
      "1500",
      "vol",
      "0.2",
      "fade",
      "q",
      "0.002",
      "0.025",
      "0.01",
      "highpass",
      "500",
      "lowpass",
      "3500",
      "gain",
      "-25",
    ],
    900,
  );
};

export const playCodecStaticBurst = (): Promise<void> => {
  return playSoxSynth(
    [
      "synth",
      "0.07",
      "whitenoise",
      "vol",
      "0.16",
      "highpass",
      "1200",
      "lowpass",
      "5200",
      "fade",
      "q",
      "0.002",
      "0.07",
      "0.02",
      "gain",
      "-28",
    ],
    1000,
  );
};

export const playCodecAlertTone = (): Promise<void> => {
  return playSoxSynth(
    [
      "synth",
      "0.08",
      "sine",
      "860",
      "vol",
      "0.22",
      ":",
      "synth",
      "0.08",
      "sine",
      "860",
      "vol",
      "0.22",
      "delay",
      "0.0",
      "0.10",
      "fade",
      "q",
      "0.01",
      "0.24",
      "0.04",
      "highpass",
      "380",
      "lowpass",
      "3100",
      "gain",
      "-22",
    ],
    1600,
  );
};

const recordAudio = async (
  outputPath: string,
  duration: number = 10,
  voiceDetectLevel: number = 30,
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const args = [
      "-t",
      "alsa",
      "default",
      "-t",
      recordFileFormat,
      "-c",
      "1",
      "-r",
      "16000",
      outputPath,
      "silence",
      "1",
      "0.1",
      `${voiceDetectLevel}%`,
      "1",
      "0.7",
      `${voiceDetectLevel}%`,
    ];
    console.log(`Starting recording, maximum ${duration} seconds...`);
    currentRecordingReject = reject;
    const recordingProcess = spawn("sox", args);

    recordingProcess.on("error", (err) => {
      killAllRecordingProcesses();
      reject(err);
    });

    recordingProcess.stdout?.on("data", (data) => {
      console.log(data.toString());
    });
    recordingProcess.stderr?.on("data", (data) => {
      console.error(data.toString());
    });

    recordingProcess.on("exit", (code) => {
      if (code && code !== 0) {
        killAllRecordingProcesses();
        reject(code);
        return;
      }
      resolve(outputPath);
      killAllRecordingProcesses();
    });
    recordingProcessList.push(recordingProcess);

    // Set a timeout to kill the recording process after the specified duration
    setTimeout(() => {
      if (recordingProcessList.includes(recordingProcess)) {
        killAllRecordingProcesses();
        resolve(outputPath);
      }
    }, duration * 1000);
  });
};

const recordAudioManually = (
  outputPath: string
): { result: Promise<string>; stop: () => void } => {
  let stopFunc: () => void = noop;
  const result = new Promise<string>((resolve, reject) => {
    currentRecordingReject = reject;
    const recordingProcess = spawn("sox", [
      "-t",
      "alsa",
      "default",
      "-t",
      recordFileFormat,
      "-c",
      "1",
      "-r",
      "16000",
      outputPath,
    ]);

    recordingProcess.on("error", (err) => {
      killAllRecordingProcesses();
      reject(err);
    });

    recordingProcess.stderr?.on("data", (data) => {
      console.error(data.toString());
    });
    recordingProcessList.push(recordingProcess);
    stopFunc = () => {
      killAllRecordingProcesses();
    };
    recordingProcess.on("exit", () => {
      resolve(outputPath);
    });
  });
  return {
    result,
    stop: stopFunc,
  };
};

const stopRecording = (): void => {
  if (!isEmpty(recordingProcessList)) {
    killAllRecordingProcesses();
    try {
      currentRecordingReject();
    } catch (e) { }
    console.log("Recording stopped");
  } else {
    console.log("No recording process running");
  }
};

interface Player {
  isPlaying: boolean;
  process: ChildProcess | null;
}

const player: Player = {
  isPlaying: false,
  process: null,
};
let activePlaybackProcess: ChildProcess | null = null;

setTimeout(() => {
  player.process = startPlayerProcess();
}, 5000);

const playAudioData = (params: TTSResult): Promise<void> => {
  const { duration: audioDuration, filePath, base64, buffer } = params;
  if (audioDuration <= 0 || (!filePath && !base64 && !buffer)) {
    console.log("No audio data to play, skipping playback.");
    return Promise.resolve();
  }
  // play wav file using aplay
  if (filePath) {
    const playbackArgs = codecAudioFxEnabled
      ? [filePath, "-t", "alsa", alsaOutputDevice, ...getCodecVoiceEffects()]
      : [filePath, "-t", "alsa", alsaOutputDevice];
    return Promise.race([
      new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, audioDuration + 1000);
      }),
      new Promise<void>((resolve, reject) => {
        console.log("Playback duration:", audioDuration);
        player.isPlaying = true;
        const process = spawn("sox", playbackArgs);
        activePlaybackProcess = process;
        process.on("close", (code: number) => {
          activePlaybackProcess = null;
          player.isPlaying = false;
          if (code !== 0) {
            console.error(`Audio playback error: ${code}`);
            reject(code);
          } else {
            console.log("Audio playback completed");
            resolve();
          }
        });
      }),
    ]).catch((error) => {
      console.error("Audio playback error:", error);
    });
  }

  // play wav/mp3 buffer based on configured TTS format
  return new Promise((resolve, reject) => {
    const audioBuffer = base64 ? Buffer.from(base64, "base64") : buffer;
    if (!audioBuffer) {
      resolve();
      return;
    }
    console.log("Playback duration:", audioDuration);
    player.isPlaying = true;

    if (codecAudioFxEnabled) {
      const soxInputType = ttsAudioFormat === "wav" ? "wav" : "mp3";
      const process = spawn("sox", [
        "-t",
        soxInputType,
        "-",
        "-t",
        "alsa",
        alsaOutputDevice,
        ...getCodecVoiceEffects(),
      ]);
      activePlaybackProcess = process;
      let settled = false;
      const finishSuccess = () => {
        if (settled) {
          return;
        }
        settled = true;
        player.isPlaying = false;
        console.log("Audio playback completed");
        resolve();
      };
      const finishError = (code: number | null) => {
        if (settled) {
          return;
        }
        settled = true;
        player.isPlaying = false;
        console.error(`Audio playback error: ${code}`);
        reject(code);
      };
      const timeout = setTimeout(() => {
        try {
          process.kill("SIGTERM");
        } catch {}
        finishSuccess();
      }, audioDuration + 1200);

      process.stdout?.on("data", (data) => console.log(data.toString()));
      process.stderr?.on("data", (data) => console.error(data.toString()));
      process.on("exit", (code) => {
        clearTimeout(timeout);
        activePlaybackProcess = null;
        if (code !== 0) {
          finishError(code);
        } else {
          finishSuccess();
        }
      });
      process.stdin?.end(audioBuffer);
      return;
    }

    const timeout = setTimeout(() => {
      resolve();
      player.isPlaying = false;
      console.log("Audio playback completed");
    }, audioDuration); // Add 1 second buffer

    if (ttsAudioFormat === "wav") {
      const process = spawn("sox", [
        "-t",
        "wav",
        "-",
        "-t",
        "alsa",
        alsaOutputDevice,
      ]);
      activePlaybackProcess = process;
      process.stdout?.on("data", (data) => console.log(data.toString()));
      process.stderr?.on("data", (data) => console.error(data.toString()));
      process.on("exit", (code) => {
        clearTimeout(timeout);
        activePlaybackProcess = null;
        player.isPlaying = false;
        if (code !== 0) {
          console.error(`Audio playback error: ${code}`);
          reject(code);
        } else {
          console.log("Audio playback completed");
          resolve();
        }
      });
      process.stdin?.end(audioBuffer);
      return;
    }

    const process = player.process;
    if (!process) {
      clearTimeout(timeout);
      return reject(new Error("Audio player is not initialized."));
    }

    try {
      process.stdin?.write(audioBuffer);
    } catch (e) { }
    process.stdout?.on("data", (data) => console.log(data.toString()));
    process.stderr?.on("data", (data) => console.error(data.toString()));
    process.on("exit", (code) => {
      clearTimeout(timeout);
      player.isPlaying = false;
      if (code !== 0) {
        console.error(`Audio playback error: ${code}`);
        reject(code);
      } else {
        console.log("Audio playback completed");
        resolve();
      }
    });
  });
};

const stopPlaying = (): void => {
  if (player.isPlaying) {
    try {
      console.log("Stopping audio playback");
      if (activePlaybackProcess) {
        activePlaybackProcess.kill("SIGTERM");
        activePlaybackProcess = null;
      }
      const process = player.process;
      if (process) {
        process.stdin?.end();
        process.kill();
      }
    } catch { }
    player.isPlaying = false;
    // Recreate process
    setTimeout(() => {
      player.process = startPlayerProcess();
    }, 500);
  } else {
    console.log("No audio currently playing");
  }
};

// Close audio player when exiting program
process.on("SIGINT", () => {
  try {
    if (activePlaybackProcess) {
      activePlaybackProcess.kill("SIGTERM");
      activePlaybackProcess = null;
    }
    if (player.process) {
      player.process.stdin?.end();
      player.process.kill();
    }
  } catch { }
  process.exit();
});

export {
  recordAudio,
  recordAudioManually,
  stopRecording,
  playAudioData,
  stopPlaying,
};

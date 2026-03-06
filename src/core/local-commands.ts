export type LocalCommand =
  | { type: "add_reminder"; text: string }
  | { type: "list_reminders" }
  | { type: "delete_reminder"; index: number }
  | { type: "clear_reminders" }
  | { type: "start_mission"; minutes?: number }
  | { type: "pause_mission" }
  | { type: "resume_mission" }
  | { type: "mission_status" }
  | { type: "abort_mission" };

const OTACON_PREFIX_RE = /^otacon[\s,.:;!-]*/i;

export const stripOtaconPrefix = (input: string): string => {
  return input.trim().replace(OTACON_PREFIX_RE, "").trim();
};

const parseIntSafe = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
};

export const parseLocalCommand = (rawInput: string): LocalCommand | null => {
  const cleaned = stripOtaconPrefix(rawInput);
  if (!cleaned) {
    return null;
  }

  const normalized = cleaned.toLowerCase().trim().replace(/\?+$/, "");

  const addReminderMatch = cleaned.match(
    /^(?:please\s+)?(?:remind me(?:\s+(?:to|about))?|add\s+(?:a\s+)?(?:task|reminder)|create\s+(?:a\s+)?(?:task|reminder))\s+(.+)$/i,
  );
  if (addReminderMatch?.[1]) {
    const text = addReminderMatch[1].trim().replace(/[.]+$/, "");
    if (text) {
      return { type: "add_reminder", text };
    }
  }

  if (
    /^(?:what do i need to do|what are my reminders|what are my tasks|what's on my reminders|list(?: my)? (?:reminders|tasks)|show(?: me)?(?: my)? (?:reminders|tasks))$/i.test(
      normalized,
    )
  ) {
    return { type: "list_reminders" };
  }

  const deleteReminderMatch = normalized.match(
    /^(?:delete|remove|complete|done)\s+(?:reminder|task)\s*(?:number\s*)?#?\s*(\d+)$/i,
  );
  if (deleteReminderMatch?.[1]) {
    const index = parseIntSafe(deleteReminderMatch[1]);
    if (index && index > 0) {
      return { type: "delete_reminder", index };
    }
  }

  if (
    /^(?:clear|delete all|remove all)\s+(?:reminders|tasks)$/i.test(normalized)
  ) {
    return { type: "clear_reminders" };
  }

  const startMissionMatch = normalized.match(
    /^(?:start\s+(?:mission|pomodoro))(?:\s+for)?(?:\s+(\d+))?(?:\s*(?:min|mins|minute|minutes))?$/i,
  );
  if (startMissionMatch) {
    const minutes = parseIntSafe(startMissionMatch[1]);
    return { type: "start_mission", minutes };
  }

  if (/^pause mission$/i.test(normalized)) {
    return { type: "pause_mission" };
  }

  if (/^resume mission$/i.test(normalized)) {
    return { type: "resume_mission" };
  }

  if (
    /^(?:mission status|status mission|what is mission status|what's mission status)$/i.test(
      normalized,
    )
  ) {
    return { type: "mission_status" };
  }

  if (/^(?:abort|stop|cancel|end)\s+mission$/i.test(normalized)) {
    return { type: "abort_mission" };
  }

  return null;
};


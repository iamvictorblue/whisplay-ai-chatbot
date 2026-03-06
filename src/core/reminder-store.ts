import fs from "fs";
import path from "path";

interface ReminderStoreFile {
  reminders: string[];
  updated_at: string;
}

export class ReminderStore {
  private filePath: string;
  private maxItems: number;
  private reminders: string[] = [];

  constructor(filePath: string, maxItems: number = 120) {
    this.filePath = filePath;
    this.maxItems = Math.max(1, maxItems);
    this.load();
  }

  getAll(): string[] {
    return [...this.reminders];
  }

  add(text: string): { ok: boolean; item?: string; reason?: string } {
    const normalized = text.trim();
    if (!normalized) {
      return { ok: false, reason: "empty" };
    }
    if (this.reminders.length >= this.maxItems) {
      return { ok: false, reason: "limit" };
    }
    this.reminders.push(normalized);
    this.save();
    return { ok: true, item: normalized };
  }

  deleteByIndex(oneBasedIndex: number): { ok: boolean; deleted?: string } {
    const index = oneBasedIndex - 1;
    if (index < 0 || index >= this.reminders.length) {
      return { ok: false };
    }
    const deleted = this.reminders.splice(index, 1)[0];
    this.save();
    return { ok: true, deleted };
  }

  clear(): number {
    const count = this.reminders.length;
    if (count === 0) {
      return 0;
    }
    this.reminders = [];
    this.save();
    return count;
  }

  private ensureParentDir(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  private load(): void {
    try {
      this.ensureParentDir();
      if (!fs.existsSync(this.filePath)) {
        this.save();
        return;
      }
      const raw = fs.readFileSync(this.filePath, "utf8");
      if (!raw.trim()) {
        this.save();
        return;
      }
      const parsed = JSON.parse(raw) as ReminderStoreFile | string[];
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.reminders)
          ? parsed.reminders
          : [];
      this.reminders = list
        .map((item) => `${item}`.trim())
        .filter((item) => item.length > 0)
        .slice(0, this.maxItems);
    } catch (error) {
      console.error("[ReminderStore] Failed to load reminders:", error);
      this.reminders = [];
    }
  }

  private save(): void {
    try {
      this.ensureParentDir();
      const tempPath = `${this.filePath}.tmp`;
      const payload: ReminderStoreFile = {
        reminders: this.reminders,
        updated_at: new Date().toISOString(),
      };
      fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      console.error("[ReminderStore] Failed to save reminders:", error);
    }
  }
}


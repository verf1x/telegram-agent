import { randomUUID } from "node:crypto";
import type { ConversationMessage, MaterialReference, PreparedAttachment } from "./contracts.ts";

export const SUMMARY_BYTES = 16 * 1024;
const HISTORY_BYTES = 4_000_000;
const HISTORY_TEXT_BUDGET = 64 * 1024;
const HISTORY_MESSAGES = 12;
const IMAGE_TEXT_WEIGHT = 512;
const SUMMARY_CHARS_PER_BATCH = 12_000;

function footprint(message: ConversationMessage) {
  let text = Buffer.byteLength(message.text);
  let bytes = 0;
  for (const attachment of message.attachments ?? []) {
    bytes += Buffer.byteLength(JSON.stringify(attachment));
    text += Buffer.byteLength(attachment.text) + attachment.images.length * IMAGE_TEXT_WEIGHT;
  }
  return { bytes, text };
}

/** Keep a contiguous suffix of completed turns and reserve capacity for incoming material. */
export function recentHistoryStart(history: ConversationMessage[], incoming?: ConversationMessage, limitScale = 1): number {
  const total = incoming ? footprint(incoming) : { bytes: 0, text: 0 };
  const incomingMessages = incoming ? 2 : 0;
  let start = history.length;
  while (start > 0) {
    let turnStart = start - 1;
    if (history[turnStart]?.role === "assistant" && history[turnStart - 1]?.role === "user") turnStart--;
    if (history.length - turnStart + incomingMessages > HISTORY_MESSAGES * limitScale) break;
    for (const message of history.slice(turnStart, start)) {
      const size = footprint(message);
      total.bytes += size.bytes;
      total.text += size.text;
    }
    if (total.bytes > HISTORY_BYTES * limitScale || total.text > HISTORY_TEXT_BUDGET * limitScale) break;
    start = turnStart;
  }
  return start;
}

export interface ArchivedMaterial extends MaterialReference { attachment: PreparedAttachment; }

/** Old records predate stable source IDs. Preserve their prepared copies on first compaction. */
export function compactionInput(messages: ConversationMessage[]) {
  const archived: ArchivedMaterial[] = [];
  const entries = messages.map(({ role, text, materials, attachments }) => {
    const refs = materials ? [...materials] : (attachments ?? []).map(attachment => {
      const {name} = attachment;
      const id = randomUUID();
      archived.push({id, name, attachment});
      return {id, name};
    });
    return {role, text, materials: refs};
  });
  return { archived, batches: summaryBatches(entries) };
}

function* summaryBatches(entries: Array<{role: string; text: string; materials: MaterialReference[]}>) {
  let batch = "";
  for (const entry of entries) {
    const refs = entry.materials.length ? "\nMaterials: " + JSON.stringify(entry.materials) : "";
    const message = `[${entry.role}]${refs}\n${entry.text}\n\n`;
    if (batch && batch.length + message.length > SUMMARY_CHARS_PER_BATCH) {
      yield batch;
      batch = "";
    }
    let offset = 0;
    while (message.length - offset > SUMMARY_CHARS_PER_BATCH) {
      let end = offset + SUMMARY_CHARS_PER_BATCH;
      // Keep supplementary characters intact at chunk boundaries.
      const last = message.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end--;
      yield message.slice(offset, end);
      offset = end;
    }
    batch += message.slice(offset);
  }
  if (batch) yield batch;
}

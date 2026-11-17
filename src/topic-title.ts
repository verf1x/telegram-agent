export const DEFAULT_TOPIC_TITLE = "Новый диалог";
export const GENERIC_TOPIC_TITLE = "Обсуждение задания";

// Title generation needs the subject of the request, not quoted data or identifiers.
export function topicTitleInput(text: string): string {
  return text.slice(0, 4000).normalize("NFKC")
    .replace(/```[\s\S]*?(?:```|$)|`[^`\r\n]*`/gu, " ")
    .replace(/"[^"\r\n]+"|«[^»\r\n]+»|“[^”\r\n]+”/gu, " ")
    .replace(/\b(?:[\w+.-]+:\/\/|www\.)[^\s]+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+|@[\p{L}\p{N}_]+/gu, " ")
    .replace(/(?<![\p{L}\p{N}_])(?:пароль|паспорт|снилс|инн|токен|секрет|password|passphrase|api[ _-]?key|token|secret|account[ _-]?id)\s*[:=]\s*[^\r\n]+/giu, " ")
    .replace(/\bBearer\s+\S+|(?:[\p{L}\p{N}_-]+\.)+[\p{L}]{2,}|[A-Za-z0-9_=-]{24,}/giu, " ")
    .replace(/(?<!\p{L})(?:проект[ауеом]?|компани[ияюе]|клиент[ауе]?|логин|project|company|client|username)\s+\p{Lu}[\p{L}\p{M}-]+/gu, " ")
    .replace(/(?<!\p{L})\p{Lu}[\p{Ll}\p{M}-]+(?:[ \t]+\p{Lu}[\p{Ll}\p{M}-]+)+/gu, " ")
    .replace(/\b(HTTP|TLS|OAuth|IPv|Python|Node|GPT)[/-]?\d[\d.]*\b/gi, "$1")
    .replace(/\S*\p{N}\S*/gu, " ")
    .replace(/\s+/gu, " ").trim().slice(0, 4000);
}

export function safeTopicTitle(proposal: string | undefined): string | undefined {
  const title = proposal?.normalize("NFKC").trim();
  if (!title) return undefined;
  // Allow words only. Handles, links, IDs, formatting, and multiline output
  // are replaced with a short generic title.
  if (title.length > 64 || Buffer.byteLength(title) > 128 ||
      !/^[\p{L}\p{M}]+(?:[ -][\p{L}\p{M}]+)*$/u.test(title) ||
      topicTitleInput(title) !== title ||
      title === DEFAULT_TOPIC_TITLE || title === "Предыдущий диалог")
    return GENERIC_TOPIC_TITLE;
  return title;
}

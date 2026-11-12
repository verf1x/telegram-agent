import type { ModelResponse, OutgoingPart } from '../contracts.ts';

/** Telegram plain messages are measured in UTF-16 units; never cut a surrogate. */
export function formatText(text: string): OutgoingPart[] {
  const parts: OutgoingPart[] = [];
  while (text.length) {
    let end = Math.min(4096, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    parts.push({kind:'text',text:text.slice(0,end)});
    text = text.slice(end);
  }
  return parts;
}

/** Convert Codex math delimiters only outside fenced and inline code. */
function mathMarkdown(text: string): string {
  const normalize = (value: string) => value.replace(/(`+)[\s\S]*?\1|(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]|(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)/g,
    (match: string, inline: string | undefined, block: string | undefined, formula: string | undefined) =>
      inline ? match : block !== undefined ? `$$${block}$$` : `$${formula}$`);
  let result = '', prose = '', fence = '';
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const mark = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && mark) {
      result += normalize(prose) + line;
      prose = '';
      fence = mark[1]!;
    } else if (fence) {
      result += line;
      if (mark && mark[1]![0] === fence[0] && mark[1]!.length >= fence.length) fence = '';
    } else prose += line;
  }
  return result + normalize(prose);
}

/** Keep paragraphs (and their code, table or math contents) indivisible. */
function richParts(text: string): OutgoingPart[] {
  const normalized = mathMarkdown(text);
  const lines = normalized.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const units: string[] = [];
  let unit = '';
  let fence = '';
  let math = false;
  for (const line of lines) {
    const mark = line.match(/^\s*(`{3,}|~{3,})/);
    if (mark) {
      if (!fence) fence = mark[1]!;
      else if (mark[1]![0] === fence[0] && mark[1]!.length >= fence.length) fence = '';
    }
    if (!fence && !mark) {
      const count = (line.match(/(?<!\\)\$\$/g) ?? []).length;
      if (count % 2) math = !math;
    }
    unit += line;
    if (!fence && !math && line.trim() === '') { units.push(unit); unit = ''; }
  }
  if (unit) units.push(unit);
  const result: OutgoingPart[] = [];
  let pending = '';
  // Treat every formatting marker as a potential block: deliberately conservative.
  const blocks = (value: string) => (value.match(/\n|[<>*#|]|^\s*[-+]|^\s*\d+\./gm) ?? []).length + 1;
  const safe = (value: string) => value.length <= 4000 && blocks(value) <= 200;
  const flush = () => { if (pending) result.push({kind:'rich',text:pending}); pending = ''; };
  for (const value of units) {
    if (!safe(value)) { flush(); result.push(...formatText(value)); }
    else { if (!safe(pending + value)) flush(); pending += value; }
  }
  flush();
  return result;
}

export function formatAnswer(response: Pick<ModelResponse,'text'|'images'>): OutgoingPart[] {
  return [...richParts(response.text), ...response.images.map(image => ({
    kind:'image' as const, base64:Buffer.from(image.bytes).toString('base64'), name:image.name, mime:image.mime,
  }))];
}

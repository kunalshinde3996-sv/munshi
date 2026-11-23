/**
 * Deterministic pre-processing of UNTRUSTED email bodies, run BEFORE any LLM sees them.
 *  1. Strip content a human reader cannot see (display:none, zero font, white-on-white, comments,
 *     script/style, zero-width chars) and REPORT it — never silently drop.
 *  2. Convert the remaining HTML to plain text.
 *  3. Detect prompt-injection phrasing (flag only; flags are surfaced in the UI/audit).
 */

export interface HiddenFinding {
  kind: string;
  text: string;
}

export interface InjectionFinding {
  pattern: string;
  text: string;
  where: "visible" | "hidden";
}

export interface SanitizeResult {
  text: string;
  hidden: HiddenFinding[];
  injection: InjectionFinding[];
}

const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta", "link", "wbr"]);
const TOKEN = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>/g;
const ZERO_WIDTH = /[​-‏‪-‮⁠-⁤﻿]/g;

function hiddenReason(tag: string, attrs: string): string | null {
  if (tag === "script" || tag === "style") return `${tag}_element`;
  if (/\shidden(\s|=|$)/i.test(` ${attrs}`)) return "hidden_attribute";
  const style = /style\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
  const css = (style?.[2] ?? style?.[3] ?? "").toLowerCase().replace(/\s+/g, "");
  if (!css) return null;
  if (/display:none/.test(css)) return "display_none";
  if (/visibility:hidden/.test(css)) return "visibility_hidden";
  if (/(^|;)font-size:0(px|pt|em|rem|%)?(;|$)/.test(css)) return "zero_font_size";
  if (/(^|;)opacity:0(\.0+)?(;|$)/.test(css)) return "zero_opacity";
  if (/(^|;)color:(#fff(fff)?|white|rgb\(255,255,255\))(;|$)/.test(css)) return "white_text";
  if (/text-indent:-\d{3,}/.test(css) || /left:-\d{3,}/.test(css)) return "offscreen_text";
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, "&");
}

const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}…` : s);
const collapse = (s: string) => s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

export function sanitizeEmailBody(raw: string): SanitizeResult {
  const hidden: HiddenFinding[] = [];

  if (ZERO_WIDTH.test(raw)) hidden.push({ kind: "zero_width_characters", text: "(invisible characters removed)" });
  const input = raw.replace(ZERO_WIDTH, "");

  const visible: string[] = [];
  const stack: { tag: string; reason: string | null }[] = [];
  let hiddenBuf: { kind: string; text: string } | null = null;
  const flushHidden = () => {
    if (hiddenBuf && hiddenBuf.text.trim()) hidden.push({ kind: hiddenBuf.kind, text: clip(collapse(decodeEntities(hiddenBuf.text))) });
    hiddenBuf = null;
  };
  const hiddenDepth = () => stack.find((s) => s.reason)?.reason ?? null;

  let last = 0;
  const addText = (t: string) => {
    if (!t) return;
    const reason = hiddenDepth();
    if (reason) {
      hiddenBuf = hiddenBuf ?? { kind: reason, text: "" };
      hiddenBuf.text += t;
    } else {
      flushHidden();
      visible.push(t);
    }
  };

  for (const m of input.matchAll(TOKEN)) {
    addText(input.slice(last, m.index));
    last = m.index! + m[0].length;
    const tok = m[0];
    if (tok.startsWith("<!--")) {
      const inner = tok.slice(4, -3);
      if (inner.trim()) hidden.push({ kind: "html_comment", text: clip(collapse(inner)) });
      continue;
    }
    const closing = tok.startsWith("</");
    const name = /^<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(tok)![1]!.toLowerCase();
    if (closing) {
      const i = stack.map((s) => s.tag).lastIndexOf(name);
      if (i >= 0) stack.length = i;
      if (!hiddenDepth()) flushHidden();
      if (["p", "div", "tr", "li", "h1", "h2", "h3", "table"].includes(name) && !hiddenDepth()) visible.push("\n");
      continue;
    }
    if (name === "br" && !hiddenDepth()) visible.push("\n");
    if (VOID_TAGS.has(name) || tok.endsWith("/>")) continue;
    stack.push({ tag: name, reason: hiddenReason(name, tok.slice(name.length + 1, -1)) });
  }
  addText(input.slice(last));
  flushHidden();

  const text = collapse(decodeEntities(visible.join("")));
  const injection = [
    ...detectInjection(text).map((f) => ({ ...f, where: "visible" as const })),
    ...hidden.flatMap((h) => detectInjection(h.text).map((f) => ({ ...f, where: "hidden" as const }))),
  ];
  return { text, hidden, injection };
}

const INJECTION_PATTERNS: [string, RegExp][] = [
  ["addresses_ai_assistant", /\b(ai|llm)\s+(assistants?|agents?|models?)\b/i],
  ["ignore_instructions", /\bignore\b[^.\n]{0,30}\b(previous|prior|above|earlier)\b[^.\n]{0,20}\b(instructions?|prompts?)\b/i],
  ["fake_system_instruction", /\b(system|developer|admin)\s+(instructions?|prompts?|messages?|override)\b/i],
  ["concealment", /\bdo not (mention|tell|inform|reveal|notify)\b[^.\n]{0,60}\b(user|owner|anyone)\b/i],
  [
    "exfiltration_request",
    /\b(forward|email|send|share|mail)\b[^\n]{0,60}\b(all|every)\b[^\n]{0,60}\b(statements?|contacts?|passwords?|emails?|documents?|messages?)\b/i,
  ],
];

/** Flag-only heuristic. Security does NOT depend on this catching everything (see Guard provenance). */
export function detectInjection(text: string): { pattern: string; text: string }[] {
  const out: { pattern: string; text: string }[] = [];
  for (const line of text.split("\n")) {
    for (const [pattern, re] of INJECTION_PATTERNS) {
      if (re.test(line)) out.push({ pattern, text: clip(line.trim(), 300) });
    }
  }
  return out;
}

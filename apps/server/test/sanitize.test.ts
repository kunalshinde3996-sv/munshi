import { describe, expect, it } from "vitest";
import { buildFixtureEmails } from "@munshi/mcp-gmail";
import { sanitizeEmailBody } from "../src/extraction/sanitize.js";

const fx = (id: string) => buildFixtureEmails().find((e) => e.id === id)!;

describe("sanitizeEmailBody", () => {
  it("strips display:none text from the newsletter injection and reports it", () => {
    const r = sanitizeEmailBody(fx("sbx-inject-news").body);
    expect(r.text).not.toMatch(/SYSTEM INSTRUCTION|claim-prize|address book/i);
    expect(r.text).toContain("Weekly Deals Digest");
    expect(r.hidden).toHaveLength(1);
    expect(r.hidden[0]).toMatchObject({ kind: "display_none" });
    expect(r.hidden[0]!.text).toContain("claim-prize");
    // the hidden text is also analysed for injection phrasing, marked as hidden
    expect(r.injection.some((i) => i.where === "hidden")).toBe(true);
  });

  it("flags the visible bank injection without altering legit content", () => {
    const r = sanitizeEmailBody(fx("sbx-inject-bank").body);
    expect(r.hidden).toHaveLength(0);
    const kinds = r.injection.filter((i) => i.where === "visible").map((i) => i.pattern);
    expect(kinds).toContain("addresses_ai_assistant");
    expect(kinds).toContain("exfiltration_request");
  });

  it("does not flag or alter legitimate emails", () => {
    for (const e of buildFixtureEmails().filter((x) => !x.id.startsWith("sbx-inject"))) {
      const r = sanitizeEmailBody(e.body);
      expect(r.hidden, e.id).toHaveLength(0);
      expect(r.injection, e.id).toHaveLength(0);
    }
    expect(sanitizeEmailBody(fx("sbx-bescom").body).text).toContain("Amount payable: Rs 1,847.00");
  });

  it.each([
    ['<div style="visibility:hidden">secret</div>ok', "visibility_hidden"],
    ['<p style="font-size: 0px">secret</p>ok', "zero_font_size"],
    ['<span style="color:#ffffff">secret</span>ok', "white_text"],
    ['<span style="opacity:0">secret</span>ok', "zero_opacity"],
    ["<span hidden>secret</span>ok", "hidden_attribute"],
    ["<!-- secret -->ok", "html_comment"],
    ['<div style="display:none"><b>nested secret</b></div>ok', "display_none"],
  ])("hides %s", (html, kind) => {
    const r = sanitizeEmailBody(html);
    expect(r.text).toBe("ok");
    expect(r.hidden[0]?.kind).toBe(kind);
    expect(r.hidden[0]?.text).toMatch(/secret/);
  });

  it("removes zero-width characters and reports them", () => {
    const r = sanitizeEmailBody("Pay​ now");
    expect(r.text).toBe("Pay now");
    expect(r.hidden[0]?.kind).toBe("zero_width_characters");
  });
});

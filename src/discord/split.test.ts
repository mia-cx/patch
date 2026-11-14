import { describe, expect, it } from "vitest";
import { MESSAGE_SPLIT as S } from "../conversation/reserved-tokens.js";
import { isCasualBurst, splitDiscordResponse } from "./split.js";

describe("splitDiscordResponse", () => {
  // Proves explicit markers outside code are the only message boundaries, and every newline inside a message survives.
  it.each([
    [
      "sends each line of a casual burst as its own message",
      "first\nsecond\n\nthird",
      ["first", "second", "third"],
    ],
    [
      "keeps a list's newlines inside one message",
      "my picks:\n- teal\n- violet",
      ["my picks:\n- teal\n- violet"],
    ],
    [
      "splits at the canonical marker with no added whitespace",
      `one\n  two${S}three\n\nfour`,
      ["one\n  two", "three\n\nfour"],
    ],
    [
      "splits around ATX headings",
      `## plan\nfirst\nsecond${S}## next\nthird`,
      ["## plan\nfirst\nsecond", "## next\nthird"],
    ],
    [
      "splits around setext headings",
      `Plan\n====\nfirst${S}Next\n----\nsecond`,
      ["Plan\n====\nfirst", "Next\n----\nsecond"],
    ],
    [
      "splits lists and quotes",
      `- a\n- b${S}> quoted\n> more${S}1. x\n2. y`,
      ["- a\n- b", "> quoted\n> more", "1. x\n2. y"],
    ],
    [
      "keeps the marker literal in a backtick fence",
      `\`\`\`ts\nconst x = "${S}";\n\`\`\`${S}after`,
      [`\`\`\`ts\nconst x = "${S}";\n\`\`\``, "after"],
    ],
    [
      "keeps the marker literal in a tilde fence",
      `~~~\n${S}\n~~~${S}after`,
      [`~~~\n${S}\n~~~`, "after"],
    ],
    [
      "keeps a fence open past a shorter closing run",
      `\`\`\`\`\n\`\`\`\n${S}\n\`\`\`\``,
      [`\`\`\`\`\n\`\`\`\n${S}\n\`\`\`\``],
    ],
    [
      "keeps the marker literal in an unclosed fence",
      `intro${S}\n\`\`\`\ncode ${S} code`,
      ["intro", `\`\`\`\ncode ${S} code`],
    ],
    [
      "keeps the marker literal in inline code",
      `type \`${S}\` here${S}next`,
      [`type \`${S}\` here`, "next"],
    ],
    [
      "matches inline code by run length",
      `\`\`a \` ${S} b\`\`${S}next`,
      [`\`\`a \` ${S} b\`\``, "next"],
    ],
    [
      "keeps fence-like text inside inline code inert",
      `use \`${S}~~~\` here${S}after`,
      [`use \`${S}~~~\` here`, "after"],
    ],
    [
      "keeps a tilde line inside multiline inline code inert",
      `use \`one\n~~~\ntwo\` here${S}after`,
      ["use `one\n~~~\ntwo` here", "after"],
    ],
    ["ignores an unmatched backtick", `5\` tall${S}next`, ["5` tall", "next"]],
    [
      "opens and closes fences directly beside markers",
      `intro${S}\`\`\`ts\n${S}\n\`\`\`${S}outro`,
      ["intro", `\`\`\`ts\n${S}\n\`\`\``, "outro"],
    ],
    [
      "accepts the legacy marker",
      "first\n\n<split />\n\nsecond<SPLIT/>third",
      ["first", "second", "third"],
    ],
    ["keeps the legacy marker literal in code", "`<split />`", ["`<split />`"]],
    ["drops empty messages between adjacent markers", `a${S}${S}b`, ["a", "b"]],
  ])("%s", (_reason, input, expected) => {
    expect(splitDiscordResponse(input)).toEqual(expected);
  });

  // Proves a single marked message over Discord's limit still hard-splits below 2000 characters.
  it("hard-splits a long marked message under the transport limit", () => {
    const long = Array.from(
      { length: 60 },
      (_, i) => `line ${i} ${"x".repeat(40)}`,
    ).join("\n");
    const chunks = splitDiscordResponse(`short${S}${long}`);

    expect(chunks[0]).toBe("short");
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.slice(1).join("\n")).toBe(long);
  });

  // Proves bursts stay capped at six messages, grouping marked chunks evenly.
  it("caps burst count", () => {
    expect(
      splitDiscordResponse(Array.from({ length: 9 }, (_, i) => i + 1).join(S)),
    ).toEqual(["1\n2", "3\n4", "5\n6", "7", "8", "9"]);
  });
});

describe("isCasualBurst", () => {
  // Proves only short casual multi-line output without markers or Markdown structure asks for repair.
  it.each([
    ["casual blank-line burst", "first\nsecond\n\nthird", true],
    ["short four-line burst", "one\ntwo\nthree\nfour", true],
    ["one line", "just one", false],
    ["canonical marker present", `first${S}second\nthird`, false],
    ["legacy marker present", "first<split />second\nthird", false],
    ["list", "- first\n- second", false],
    ["ATX heading", "## plan\nfirst", false],
    ["indented ATX heading", "intro\n   # plan", false],
    ["setext heading", "Plan\n===\nfirst", false],
    ["Discord subtext", "first\n-# small print", false],
    ["indented content", "first\n    second", false],
    ["blockquote", "> quoted\nreply", false],
    ["inline code", "run `ls`\nthen look", false],
    ["tilde fence", "~~~\ncode\n~~~", false],
    ["long line", `${"x".repeat(181)}\nshort`, false],
    ["many lines", "one\ntwo\nthree\nfour\nfive", false],
  ])("%s", (_reason, input, expected) => {
    expect(isCasualBurst(input)).toBe(expected);
  });
});

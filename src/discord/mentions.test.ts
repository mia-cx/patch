import { describe, expect, it } from "vitest";
import { repairMentions } from "./mentions.js";

const PARTICIPANTS = [
  { id: "111", username: "kel", name: "Kelechi" },
  { id: "222", username: "noor", name: "Sam" },
  { id: "333", username: "noor.b", name: "Sam" },
];

describe("repairMentions", () => {
  // Proves only conversation participants can be pinged, whatever mention form the model writes.
  it.each([
    ["username", "@kel look", "<@111> look"],
    ["username ending a sentence", "hey @KEL.", "hey <@111>."],
    ["dotted username", "@noor.b hi", "<@333> hi"],
    ["unique display name", "@Kelechi hi", "<@111> hi"],
    ["ambiguous display name", "@Sam hi", "@Sam hi"],
    ["unknown name", "@ghost hi", "@ghost hi"],
    ["participant ID", "<@!111> yo", "<@111> yo"],
    ["unknown ID", "btw <@999> one more", "btw one more"],
    ["name inside raw syntax", "<@kel> hi", "<@111> hi"],
    ["unknown name inside raw syntax", "<@ghost> hi", "@ghost hi"],
    ["role", "<@&555> all", "all"],
    ["mass mentions", "@everyone @here", "@everyone @here"],
    ["code and email", "`@kel` me@kel.dev", "`@kel` me@kel.dev"],
  ])("%s", (_, text, expected) => {
    expect(repairMentions(text, PARTICIPANTS)).toBe(expected);
  });
});

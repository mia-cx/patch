import { describe, expect, it } from "vitest";
import { paginate } from "./pages.js";

describe("paginate", () => {
  // Proves a record that fits on a page is never split across two.
  it("packs whole blocks and starts a new page before one would overflow", () => {
    expect(paginate(["aaaa", "bbbb", "cccc"], "\n", 9)).toEqual([
      "aaaa\nbbbb",
      "cccc",
    ]);
  });

  // Proves a block longer than a page continues on the next pages with nothing dropped.
  it("splits only a block longer than a page, losslessly", () => {
    const long = "x".repeat(25);
    const pages = paginate(["head", long, "tail"], "\n", 10);
    expect(pages).toEqual([
      "head",
      "x".repeat(10),
      "x".repeat(10),
      "x".repeat(5),
      "tail",
    ]);
    expect(pages.every((page) => page.length <= 10)).toBe(true);
  });
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBotIdentity, renderIdentityTemplate } from "./identity.js";

describe("loadBotIdentity", () => {
  // Proves the file supplies identity, env overrides win, and unknown legacy fields are ignored.
  it("loads identity JSON with env overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-identity-"));
    const identityPath = join(dir, "identity.json");
    writeFileSync(
      identityPath,
      JSON.stringify({
        name: "Quilt",
        pronouns: "they/them",
        aliases: ["quiltbot"],
        project: "Quilt",
        background: "talking blanket",
        interests: ["ambient pads"],
      }),
    );

    expect(
      loadBotIdentity({ BOT_IDENTITY_PATH: identityPath, BOT_NAME: "Needle" }),
    ).toEqual({
      name: "Needle",
      pronouns: "they/them",
      aliases: ["quiltbot"],
      project: "Quilt",
      background: "talking blanket",
    });
  });
});

describe("renderIdentityTemplate", () => {
  // Proves placeholders render strings and lists, and unknown keys stay visible.
  it("renders identity placeholders", () => {
    expect(
      renderIdentityTemplate(
        "{{identity.name}} ({{identity.aliases}}) is {{identity.background}}; {{identity.missing}}",
        {
          name: "Needle",
          pronouns: "they/them",
          aliases: ["needle", "n"],
          project: "Needle",
          background: "a talking pincushion",
        },
      ),
    ).toBe("Needle (needle, n) is a talking pincushion; {{identity.missing}}");
  });
});

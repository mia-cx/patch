import { readFileSync } from "node:fs";
import { Template } from "@huggingface/jinja";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { toLlmTools } from "./action-context.js";
import { actionInput } from "./context.js";
import { registerHarnessActions } from "./harness.js";
import { createPatchActionRegistry } from "./registry.js";
import { isToolCallTrigger } from "./tool-calls.js";

// Exact declaration macros, lines 1–155 of google/gemma-4-E4B-it@4ecc2ba63bcac23ba4a767fc87025b1450f84c9c.
const source = readFileSync(
  new URL("../../test/fixtures/gemma4-declarations.jinja", import.meta.url),
  "utf8",
);
const template = new Template(
  `${source}\n{% for tool in tools %}{{ format_function_declaration(tool) }}\n{% endfor %}`,
);

describe("native Gemma declarations", () => {
  // Proves actual registered tools render visible argument types and complete declarations with the pinned Gemma macros.
  it("renders recurring alternatives, zero-arg objects and optional fields through Gemma's native declaration macros", () => {
    const registry = createPatchActionRegistry();
    registerHarnessActions(registry);
    const actions = registry.actions.flatMap((action) =>
      action.triggers.filter(isToolCallTrigger).map((trigger) => ({
        actionName: action.name,
        name: trigger.name,
        description: trigger.description,
        usage: trigger.usage,
        inputSchemaJson: trigger.input.jsonSchema,
        available: true,
      })),
    );
    const parsersBefore = JSON.stringify(
      actions.map((action) => action.inputSchemaJson),
    );
    const tools = toLlmTools(actions);
    for (const tool of tools) {
      const rendered = template.render({ tools: [tool] });
      expect(rendered).not.toContain('type:<|"|><|"|>');
      expect(rendered).toContain('type:<|"|>OBJECT<|"|>}}');
      if (tool.function.name === "schedule_followup") {
        for (const field of ["at", "cron", "timezone", "text"])
          expect(rendered).toContain(`${field}:{type:<|"|>STRING<|"|>}`);
        expect(rendered).toContain("once OR {cron,timezone,text}");
        expect(rendered).toContain('required:[<|"|>text<|"|>]');
      }
      if (["channel_assets", "list_followups"].includes(tool.function.name))
        expect(rendered).toContain('parameters:{type:<|"|>OBJECT<|"|>}}');
    }
    expect(
      JSON.stringify(actions.map((action) => action.inputSchemaJson)),
    ).toBe(parsersBefore);
  });

  // Proves nullable integers and nested nullable array/object properties render usable types without relaxing the real parser.
  it("renders recursively nullable fields while preserving strict runtime decoding", () => {
    const parser = actionInput(
      Schema.Struct({
        id: Schema.Union([
          Schema.Int.check(Schema.isGreaterThan(0)),
          Schema.Null,
        ]),
        nested: Schema.Array(
          Schema.Struct({ label: Schema.Union([Schema.String, Schema.Null]) }),
        ),
      }),
    );
    const tools = toLlmTools([
      {
        actionName: "synthetic_forget",
        name: "synthetic_forget",
        description: "Synthetic nullable input.",
        usage: "Synthetic only.",
        inputSchemaJson: parser.jsonSchema,
        available: true,
      },
    ]);
    const rendered = template.render({ tools });
    expect(rendered).toContain('id:{nullable:true,type:<|"|>INTEGER<|"|>}');
    expect(rendered).toContain('label:{nullable:true,type:<|"|>STRING<|"|>}');
    expect(rendered).toContain('type:<|"|>ARRAY<|"|>');
    expect(rendered).not.toContain('type:<|"|><|"|>');
    expect(parser.parse({ id: null, nested: [{ label: null }] })).toEqual({
      id: null,
      nested: [{ label: null }],
    });
    for (const id of [0, 1.5, "1"])
      expect(() => parser.parse({ id, nested: [] })).toThrow();
    expect(() =>
      parser.parse({ id: 1, nested: [], destination: "elsewhere" }),
    ).toThrow();
  });
});

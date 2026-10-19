import { createHash } from "node:crypto";
import type { LlmMessage } from "../llm/client.js";
import type { ObservationSegment } from "../llm/evidence.js";

type Result = {
  name: string;
  output?: unknown;
  completed: boolean;
  truncated?: boolean;
};
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Bind actual web text by JSON path, so identical strings from different URLs cannot alias. */
export function toolResultMessage(
  results: readonly Result[],
  prefix: string,
  sourcePrefix: string,
): LlmMessage {
  const bindings = new Map<string, { tool: string; url: string }>();
  const value = JSON.parse(JSON.stringify(results)) as Json;
  for (const [index, result] of results.entries()) {
    if (!result.completed || result.truncated || !record(result.output))
      continue;
    const output = result.output;
    const add = (path: (string | number)[], text: unknown, url: unknown) => {
      if (
        typeof text === "string" &&
        text.trim() &&
        typeof url === "string" &&
        url.trim()
      )
        bindings.set(JSON.stringify(path), { tool: result.name, url });
    };
    if (result.name === "web_fetch") {
      for (const key of ["title", "text"])
        add([index, "output", key], output[key], output.url);
    }
    if (result.name === "web_search" && Array.isArray(output.results)) {
      for (const [rowIndex, row] of output.results.entries()) {
        if (!record(row)) continue;
        for (const key of ["title", "snippet"])
          add([index, "output", "results", rowIndex, key], row[key], row.url);
      }
    }
    // Fact recall and replayable notebook/action receipts require a parent-reference wire.
    // Treating those as new independent observations could restore erased evidence.
  }
  const observationSources: ObservationSegment[] = [];
  let content = prefix;
  const append = (item: Json, path: (string | number)[]) => {
    const binding = bindings.get(JSON.stringify(path));
    if (typeof item === "string" && binding) {
      const start = content.length;
      content += JSON.stringify(item);
      const digest = createHash("sha256")
        .update(JSON.stringify([sourcePrefix, path, binding, item]))
        .digest("hex");
      observationSources.push({
        source: {
          id: `patch:tool:${digest}`,
          revision: 0,
          origin: "external_observation",
          ...binding,
        },
        start,
        end: content.length,
        encoding: "json_string",
      });
    } else if (Array.isArray(item)) {
      content += "[";
      item.forEach((child, index) => {
        if (index) content += ",";
        append(child, [...path, index]);
      });
      content += "]";
    } else if (item !== null && typeof item === "object") {
      content += "{";
      Object.entries(item).forEach(([key, child], index) => {
        if (index) content += ",";
        content += `${JSON.stringify(key)}:`;
        append(child, [...path, key]);
      });
      content += "}";
    } else content += JSON.stringify(item);
  };
  append(value, []);
  return {
    role: "user",
    content,
    ...(observationSources.length ? { observationSources } : {}),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

import { createHash } from "node:crypto";
import type { LlmMessage } from "../llm/client.js";
import type {
  CompletedGeneration,
  ObservationSegment,
} from "../llm/evidence.js";

type Result = {
  name: string;
  output?: unknown;
  completed: boolean;
  truncated?: boolean;
};
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Binding = {
  source: ObservationSegment["source"];
  context?: readonly string[];
};

/** Bind actual web values and query echoes by path; copied citations reuse their original source. */
export function toolResultMessage(
  results: readonly Result[],
  prefix: string,
  sourcePrefix: string,
  generations: readonly (CompletedGeneration | undefined)[] = [],
  resultOffset = 0,
): LlmMessage {
  const bindings = new Map<string, Binding>();
  const unknownPaths = new Set<string>();
  const parents: CompletedGeneration[] = [];
  const value = JSON.parse(JSON.stringify(results)) as Json;
  for (const [index, result] of results.entries()) {
    if (result.truncated)
      unknownPaths.add(JSON.stringify([index, "output_excerpt"]));
    if (
      !result.completed ||
      result.truncated ||
      !record(result.output) ||
      !["web_fetch", "web_search"].includes(result.name)
    ) {
      unknownPaths.add(JSON.stringify([index, "output"]));
      continue;
    }
    const output = result.output;
    const parent = generations[index];
    if (parent) parents.push(parent);
    const add = (path: (string | number)[], text: unknown, url: unknown) => {
      if (
        typeof text !== "string" ||
        !text.trim() ||
        typeof url !== "string" ||
        !url.trim()
      )
        return;
      const id = hash([
        sourcePrefix,
        resultOffset + index,
        result.name,
        url,
        text,
      ]);
      bindings.set(JSON.stringify(path), {
        source: {
          id: `patch:tool:${id}`,
          revision: 0,
          origin: "external_observation",
          tool: result.name,
          url,
        },
        ...(parent ? { context: [parent.id] } : {}),
      });
    };
    if (result.name === "web_fetch")
      for (const key of ["title", "text", "url"])
        add([index, "output", key], output[key], output.url);
    if (result.name === "web_search") {
      if (typeof output.query === "string") {
        const parent = generations[index];
        if (parent) {
          parents.push(parent);
          bindings.set(JSON.stringify([index, "output", "query"]), {
            source: {
              id: `patch:query:${hash([parent.id, output.query])}`,
              revision: 0,
              origin: "unattributed_input",
            },
            context: [parent.id],
          });
        } else unknownPaths.add(JSON.stringify([index, "output", "query"]));
      }
      if (Array.isArray(output.results))
        for (const [rowIndex, row] of output.results.entries())
          if (record(row))
            for (const key of ["title", "snippet", "url"])
              add(
                [index, "output", "results", rowIndex, key],
                row[key],
                row.url,
              );
    }
    if (Array.isArray(output.sources))
      for (const [rowIndex, row] of output.sources.entries())
        if (record(row))
          for (const key of ["title", "url"])
            add([index, "output", "sources", rowIndex, key], row[key], row.url);
  }
  const observationSources: ObservationSegment[] = [];
  const observationUnknown: { start: number; end: number }[] = [];
  let content = prefix;
  const append = (item: Json, path: (string | number)[]) => {
    const key = JSON.stringify(path);
    const binding = bindings.get(key);
    if (unknownPaths.has(key)) {
      const start = content.length;
      content += JSON.stringify(item);
      observationUnknown.push({ start, end: content.length });
    } else if (typeof item === "string" && binding) {
      const start = content.length;
      content += JSON.stringify(item);
      observationSources.push({
        ...binding,
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
    observationSources,
    observationParents: parents,
    observationUnknown,
  };
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

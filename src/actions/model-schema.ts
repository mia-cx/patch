type JsonSchema = Readonly<Record<string, unknown>>;

function isSchema(value: unknown): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Project declaration types for Gemma's properties/type renderer. Runtime parsers remain authoritative. */
export function modelDeclarationSchema(schema: JsonSchema): JsonSchema {
  const { anyOf: _anyOf, ...base } = schema;
  let declaration: Record<string, unknown> = { ...base };
  const members = Array.isArray(schema.anyOf)
    ? schema.anyOf.filter(isSchema)
    : [];
  if (members.length) {
    const nonNull = members.filter((member) => member.type !== "null");
    const [only] = nonNull;
    const numeric = nonNull.find((member) => member.type === "number");
    if (only && nonNull.length === 1 && nonNull.length < members.length) {
      declaration = {
        ...base,
        ...modelDeclarationSchema(only),
        nullable: true,
      };
    } else if (
      numeric &&
      nonNull.every(
        (member) =>
          member === numeric ||
          (member.type === "string" &&
            Array.isArray(member.enum) &&
            member.enum.every((value: unknown) =>
              ["NaN", "Infinity", "-Infinity"].includes(String(value)),
            )),
      )
    ) {
      // Effect represents non-finite numbers with string sentinels. Gemma still needs a numeric declaration.
      declaration = { ...base, ...modelDeclarationSchema(numeric) };
    } else if (
      nonNull.every(
        (member) => member.type === "object" || member.type === "array",
      )
    ) {
      // Effect's empty Struct also describes arrays. Tool declarations always expose object arguments.
      const objects = nonNull.filter((member) => member.type === "object");
      if (!objects.length)
        throw new Error("Model declarations require an object alternative");
      const properties: Record<string, unknown> = {};
      for (const object of objects) {
        if (!isSchema(object.properties)) continue;
        for (const [name, value] of Object.entries(object.properties)) {
          const previous = properties[name];
          properties[name] =
            previous === undefined ||
            JSON.stringify(previous) === JSON.stringify(value)
              ? value
              : { anyOf: [previous, value] };
        }
      }
      const required = objects.map((object) =>
        Array.isArray(object.required) ? object.required : [],
      );
      declaration = {
        ...base,
        type: "object",
        properties,
        required: (required[0] ?? []).filter((name: unknown) =>
          required.every((keys) => keys.includes(name)),
        ),
      };
    } else {
      throw new Error("Model declaration union has no single visible type");
    }
  }
  if (Array.isArray(declaration.type)) {
    const originalTypes = declaration.type;
    const types = originalTypes.filter((type: unknown) => type !== "null");
    if (types.length !== 1)
      throw new Error("Model declaration union has no single visible type");
    declaration.type = types[0];
    if (types.length < originalTypes.length) declaration.nullable = true;
  }
  if (isSchema(declaration.properties))
    declaration.properties = Object.fromEntries(
      Object.entries(declaration.properties).map(([name, property]) => [
        name,
        isSchema(property) ? modelDeclarationSchema(property) : property,
      ]),
    );
  if (isSchema(declaration.items))
    declaration.items = modelDeclarationSchema(declaration.items);
  if (declaration.type === "object") {
    declaration.properties ??= {};
    declaration.required ??= [];
  }
  return declaration;
}

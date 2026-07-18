import type { z } from "zod";

export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const def = (schema as any)._def;

  if (def.typeName === "ZodObject") {
    const shape = def.shape();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const fieldDef = (value as any)._def;
      const isOptional = fieldDef.typeName === "ZodOptional";
      const innerDef = isOptional ? fieldDef.innerType._def : fieldDef;

      properties[key] = zodFieldToJsonSchema(innerDef, value);

      if (!isOptional) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  return { type: "object", properties: {} };
}

function zodFieldToJsonSchema(def: any, original: any): Record<string, unknown> {
  const description = def.description ?? (original as any).description;
  const base: Record<string, unknown> = {};

  if (description) base.description = description;

  switch (def.typeName) {
    case "ZodString":
      return { type: "string", ...base };
    case "ZodNumber":
      return { type: "number", ...base };
    case "ZodBoolean":
      return { type: "boolean", ...base };
    case "ZodArray":
      return { type: "array", items: zodFieldToJsonSchema(def.type._def, def.type), ...base };
    default:
      return { type: "string", ...base };
  }
}

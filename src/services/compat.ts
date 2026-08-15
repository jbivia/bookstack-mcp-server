/**
 * Client compatibility shims.
 *
 * The MCP SDK builds tool schemas with `zod-to-json-schema`, which stamps them
 * `"$schema": "http://json-schema.org/draft-07/schema#"`. Some MCP clients
 * validate tool schemas with an Ajv instance configured for JSON Schema 2020-12
 * and reject any other declared dialect outright, which surfaces as:
 *
 *   Tool 'x' has an invalid outputSchema: JSON Schema declares an unsupported
 *   dialect ("$schema": "http://json-schema.org/draft-07/schema#")
 *
 * Every keyword these schemas actually use — type, properties, required, items,
 * enum, minimum/maximum, exclusiveMinimum, minLength/maxLength, default,
 * description, additionalProperties — carries identical semantics in draft-07
 * and 2020-12, so only the declaration is wrong, not the schema. Rewriting the
 * declaration on the way out is therefore safe.
 *
 * This is a shim, not a fix: once the SDK emits 2020-12 natively, drop it.
 */

const TARGET_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** Recursively rewrite every `$schema` declaration found in a value, in place. */
export function retargetJsonSchemaDialect(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) retargetJsonSchemaDialect(item);
    return;
  }
  if (value === null || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  if (typeof record["$schema"] === "string") record["$schema"] = TARGET_DIALECT;
  for (const nested of Object.values(record)) retargetJsonSchemaDialect(nested);
}

/**
 * Wrap a transport so outgoing messages get their schema dialect rewritten.
 *
 * Patching the transport rather than the server keeps this independent of how
 * the SDK generates and caches its tool list.
 */
export function patchTransportSchemaDialect<T extends object>(transport: T): T {
  const holder = transport as unknown as {
    send: (...args: unknown[]) => Promise<void>;
  };
  const original = holder.send.bind(holder);

  holder.send = async (...args: unknown[]): Promise<void> => {
    if (args.length > 0) retargetJsonSchemaDialect(args[0]);
    return original(...args);
  };

  return transport;
}

const MAX_LISTED_OPTIONAL = 12;

/**
 * One-line "what do I have to send" summary appended to a tool description:
 * `Fields - required: a, b (and at least one of: x, y). Optional: c, d.`
 * The model sees this in tools/list, so it can fill mandatory fields up front
 * instead of discovering them through a failed call.
 */
export function summarizeFields(input: {
  required: readonly string[];
  optional: readonly string[];
  oneOf?: readonly string[] | undefined;
}): string | undefined {
  const parts: string[] = [];
  const required = input.required.length > 0 ? input.required.join(", ") : "none";
  const oneOf = input.oneOf && input.oneOf.length > 0 ? ` (plus at least one of: ${input.oneOf.join(", ")})` : "";
  parts.push(`required: ${required}${oneOf}`);
  if (input.optional.length > 0) {
    const shown = input.optional.slice(0, MAX_LISTED_OPTIONAL).join(", ");
    const more = input.optional.length - MAX_LISTED_OPTIONAL;
    parts.push(`optional: ${shown}${more > 0 ? ` (+${more} more)` : ""}`);
  }
  return `Fields - ${parts.join(". ")}.`;
}

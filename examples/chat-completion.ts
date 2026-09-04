function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(): never {
  throw new Error("chat completion response is malformed");
}

// This dependency-free helper validates the fields needed to safely consume
// choice 0. Use the published schema when whole-envelope validation is needed.
export function requireCompleteChatText(value: unknown): string {
  if (!isObject(value) || !Array.isArray(value.choices)) malformed();
  const choices: unknown[] = value.choices;
  const matches = choices.filter(
    (choice) => isObject(choice) && choice.index === 0,
  );
  if (matches.length !== 1) malformed();
  const choice = matches[0];
  if (
    !isObject(choice) ||
    !isObject(choice.message) ||
    choice.message.role !== "assistant" ||
    !("content" in choice.message) ||
    !("refusal" in choice.message) ||
    !("finish_reason" in choice)
  ) {
    malformed();
  }
  const content = choice.message.content;
  const refusal = choice.message.refusal;
  if (
    !(content === null || typeof content === "string") ||
    !(refusal === null || typeof refusal === "string")
  ) {
    malformed();
  }
  if (choice.finish_reason === "content_filter" || refusal !== null)
    throw new Error("chat completion was refused or filtered");
  if (choice.finish_reason === "length")
    throw new Error("chat completion was truncated");
  if (choice.finish_reason === null)
    throw new Error("chat completion was incomplete");
  if (choice.finish_reason !== "stop") malformed();
  if (content === null || content.length === 0)
    throw new Error("chat completion was incomplete");
  return content;
}

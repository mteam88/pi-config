export const STEERING_MESSAGE_CHANNEL = "extensions:steering-message";

export type SteeringMessageSource = "user" | "subagent" | "background-terminal";

export interface SteeringMessageEvent {
  readonly source: SteeringMessageSource;
  readonly id?: string;
}

export function isSteeringMessageEvent(
  value: unknown,
): value is SteeringMessageEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = (value as { source?: unknown }).source;
  return (
    source === "user" ||
    source === "subagent" ||
    source === "background-terminal"
  );
}

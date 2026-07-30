export const COMPLETION_DELIVERY_OPTIONS = {
  deliverAs: "steer",
  triggerTurn: true,
} as const;

/**
 * Deliver an unconsumed settlement synchronously from its settle hook.
 *
 * The manager calls the hook exactly once. Its wait-interest check supplies
 * `consumed`, which prevents an active wait/cancel from also producing an
 * automatic completion message.
 */
export function deliverSettledResult<T>(
  result: T,
  consumed: boolean,
  deliver: (result: T) => void,
) {
  if (consumed) return false;
  deliver(result);
  return true;
}

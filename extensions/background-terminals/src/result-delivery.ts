export const COMPLETION_DELIVERY_OPTIONS = {
  deliverAs: "steer",
  triggerTurn: true,
} as const;

/** Deliver once, directly from the manager's one-shot settle hook. */
export function deliverSettledResult<T>(
  result: T,
  consumed: boolean,
  deliver: (result: T) => void,
) {
  if (consumed) return false;
  deliver(result);
  return true;
}

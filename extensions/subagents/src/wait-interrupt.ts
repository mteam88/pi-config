export interface WaitInterruptScope {
  readonly signal: AbortSignal;
  dispose(): void;
}

/**
 * One steering event interrupts every wait that is active at that instant.
 * Later waits receive a fresh signal and are unaffected by prior events.
 */
export function createWaitInterrupts() {
  const active = new Set<AbortController>();

  return {
    open(): WaitInterruptScope {
      const controller = new AbortController();
      active.add(controller);
      return {
        signal: controller.signal,
        dispose: () => active.delete(controller),
      };
    },
    interrupt() {
      const current = [...active];
      active.clear();
      for (const controller of current) controller.abort();
    },
    size() {
      return active.size;
    },
  };
}

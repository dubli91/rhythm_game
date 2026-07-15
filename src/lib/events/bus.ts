// Generic pub/sub event bus. Carries judgement events to gauge/renderer and
// input events to judgement (specs/judgement-scoring.md, gauge-clear.md).

export type EventMap = Record<string, unknown>;

export interface EventBus<TEvents extends EventMap> {
  /** Returns an unsubscribe function. */
  on<K extends keyof TEvents>(type: K, handler: (payload: TEvents[K]) => void): () => void;
  off<K extends keyof TEvents>(type: K, handler: (payload: TEvents[K]) => void): void;
  emit<K extends keyof TEvents>(type: K, payload: TEvents[K]): void;
  /** Remove all handlers (used on screen teardown so no residual listeners leak between plays). */
  clear(): void;
}

// Handlers are stored behind a single erased signature so a Map keyed by
// `keyof TEvents` can hold arrays of differently-typed handlers. `unknown`
// (never `any`) is used for the erasure, with casts at the two boundary
// points (register/invoke) where the concrete payload type is known.
type StoredHandler = (payload: unknown) => void;

export function createEventBus<TEvents extends EventMap>(): EventBus<TEvents> {
  const handlers = new Map<keyof TEvents, StoredHandler[]>();

  function on<K extends keyof TEvents>(
    type: K,
    handler: (payload: TEvents[K]) => void,
  ): () => void {
    const stored = handler as unknown as StoredHandler;
    const list = handlers.get(type);
    if (list) {
      list.push(stored);
    } else {
      handlers.set(type, [stored]);
    }
    return () => off(type, handler);
  }

  function off<K extends keyof TEvents>(type: K, handler: (payload: TEvents[K]) => void): void {
    const list = handlers.get(type);
    if (!list) {
      return;
    }
    const stored = handler as unknown as StoredHandler;
    const index = list.indexOf(stored);
    if (index !== -1) {
      list.splice(index, 1);
    }
  }

  function emit<K extends keyof TEvents>(type: K, payload: TEvents[K]): void {
    const list = handlers.get(type);
    if (!list || list.length === 0) {
      return;
    }
    // Snapshot so subscribe-during-emit is deferred to the next emit.
    const snapshot = list.slice();
    for (const handler of snapshot) {
      // Skip handlers unsubscribed by the time they would run.
      if (!list.includes(handler)) {
        continue;
      }
      try {
        handler(payload);
      } catch (error) {
        console.error(`[EventBus] handler for "${String(type)}" threw:`, error);
      }
    }
  }

  function clear(): void {
    handlers.clear();
  }

  return { on, off, emit, clear };
}

export type ScreenId =
  | 'TITLE'
  | 'SONG_SELECT'
  | 'SETTINGS'
  | 'PRACTICE_EDIT'
  | 'PRACTICE_PLAY'
  | 'PLAY'
  | 'RESULTS';

// Exactly the enum + edge list of app-shell-navigation.md MUST 1-2 (the IMPORT
// screen was removed with the 2026-07-16 BMS-import descope).
export const ALLOWED_TRANSITIONS: Readonly<Record<ScreenId, readonly ScreenId[]>> = {
  TITLE: ['SONG_SELECT'],
  SONG_SELECT: ['SETTINGS', 'PRACTICE_EDIT', 'PLAY'],
  SETTINGS: ['SONG_SELECT'],
  PRACTICE_EDIT: ['SONG_SELECT', 'PRACTICE_PLAY'],
  PRACTICE_PLAY: ['PRACTICE_EDIT'],
  PLAY: ['RESULTS'],
  RESULTS: ['PLAY', 'SONG_SELECT'],
};

export type ScreenChangeHandler = (from: ScreenId, to: ScreenId) => void;

export interface ScreenMachine {
  current(): ScreenId;
  canTransition(to: ScreenId): boolean;
  transition(to: ScreenId): void;
  onChange(handler: ScreenChangeHandler): () => void;
}

export function createScreenMachine(initial: ScreenId = 'TITLE'): ScreenMachine {
  let currentScreen: ScreenId = initial;
  const handlers = new Set<ScreenChangeHandler>();

  function canTransition(to: ScreenId): boolean {
    return ALLOWED_TRANSITIONS[currentScreen].includes(to);
  }

  function transition(to: ScreenId): void {
    if (!canTransition(to)) {
      throw new Error(`forbidden screen transition: ${currentScreen} -> ${to}`);
    }
    const from = currentScreen;
    currentScreen = to;
    for (const handler of handlers) {
      try {
        handler(from, to);
      } catch (error) {
        console.error(error);
      }
    }
  }

  function onChange(handler: ScreenChangeHandler): () => void {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  return {
    current: () => currentScreen,
    canTransition,
    transition,
    onChange,
  };
}

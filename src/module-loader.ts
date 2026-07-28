/**
 * Loads a module by URL without routing the runtime path through Vite's
 * module graph. This keeps external adapter loading on Node's native ESM
 * loader while allowing source files to run under Vitest.
 */
export function importExternalModule<T>(specifier: string): Promise<T> {
  return import(/* @vite-ignore */ specifier) as Promise<T>;
}

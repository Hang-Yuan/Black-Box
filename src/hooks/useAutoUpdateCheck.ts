/** Compatibility shim. App self-update is disabled for this fork. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getUpdateHandle(): any {
  return null;
}

/**
 * App self-update stays disabled until this fork owns a signed release channel.
 */
export function useAutoUpdateCheck(): void {
  // Intentionally empty.
}

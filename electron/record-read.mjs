// Small helpers that outlive the company relay they were written next to.
//
// The company (managed) relay is gone; these two helpers are still used by the
// Cloud account store, so they live here now rather than dragging the whole
// relay along with them.

/** Never readable: not a small regular file, a key that no longer opens it (Windows reinstall), or not JSON. A locked keychain is never this. */
export const unreadableRecord = error => error?.code === "unreadable_record";

export const retryDelay = attempt => [15_000, 30_000, 60_000][Math.min(attempt, 3) - 1];

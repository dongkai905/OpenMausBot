// Which engines can work on a remote computer (the person's own VPS): one rule for
// the server and the renderer.

/** The engine fact the rule reads. The server's provider instance and the
 * renderer's InstanceInfo both carry it. */
export interface CloudEngine {
  computerMcp?: boolean;
}

/** An engine with computer tools gets the remote computer as one more stdio
 * computer server, on a VPS alike. The turn always stays on the
 * bot's own engine; nothing hands it to another one. */
export function canWorkOnRemote(engine: CloudEngine | undefined): boolean {
  return engine?.computerMcp === true;
}

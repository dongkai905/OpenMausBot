export type ConnectionKind = "mcp" | "key" | "email";

export interface Connection {
  /** "mcp:<name>", "key:<provider>" or "email". */
  id: string;
  kind: ConnectionKind;
  label: string;
  runsHere?: true;
  launcher?: string;
  for?: string[];
  signIn?: true;
}

/** The computer an MCP server that needs it is marked as running on. */
export interface ConnectionComputer { environmentId: string; label: string }

export interface CollectedConnections { computer: ConnectionComputer; connections: Connection[] }

export interface ConnectionsRead extends CollectedConnections { engines: string[]; commands: string[] }

export interface ConnectionsLocal {
  json(route: string): Promise<unknown>;
  handoff(what: { kind: "connection"; id: string } | { kind: "connection-release"; id: string; digest: string }): Promise<any>;
}

export interface ConnectionsTarget {
  call(method: string, route: string, body?: unknown): Promise<{ ok: boolean; status: number; body: any }>;
}

export interface HeldSignIn { id: string; label: string; digest: string }

export interface ConnectionsMoved {
  moved: Array<{ id: string; label: string }>;
  runsHere: Array<{ id: string; label: string; needs?: string; off?: true }>;
  kept: Array<{ id: string; label: string }>;
  failed: Array<{ id: string; label: string; message: string; final: boolean }>;
  release: HeldSignIn[];
  /** Sign-ins that refresh themselves, left here for a later pass (`signIns: false`). */
  later: Array<{ id: string; label: string }>;
}

export class ConnectionMoveError extends Error {
  code: string;
  final: boolean;
  constructor(code: string, message: string, final?: boolean);
}

export function parseConnections(value: unknown): ConnectionsRead | null;
export function collectConnections(local: ConnectionsLocal): Promise<CollectedConnections>;
export function sendConnections(collected: CollectedConnections, target: ConnectionsTarget, options: {
  local: ConnectionsLocal;
  release?: boolean;
  t?(key: string, params?: Record<string, string | number>): string;
  signIns?: boolean;
  waitMs?: number;
  onProgress?: (progress: { done: number; total: number; label: string }) => void;
}): Promise<ConnectionsMoved>;
export function releaseConnections(pending: HeldSignIn[], options: { local: ConnectionsLocal; target: ConnectionsTarget }): Promise<HeldSignIn[]>;

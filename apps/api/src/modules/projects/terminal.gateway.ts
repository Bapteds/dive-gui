// WebSocket gateway for the per-project terminal.
//
// Bridges a browser WebSocket to an interactive shell (terminalSession) whose working
// directory is the project's storage root. This is the app's ONE shell-execution
// surface, so it is guarded on every axis and OFF unless TERMINAL_ENABLED=true:
//   - the endpoint refuses every upgrade when the feature is disabled;
//   - a same-origin check (the CORS middleware does not cover upgrades);
//   - JWT auth (a browser cannot set an Authorization header on a WebSocket, so the
//     access token is passed as the second Sec-WebSocket-Protocol value; we verify it,
//     re-load the user, and reject disabled accounts) — the same checks as requireAuth;
//   - project visibility (assertProjectVisible) so only members reach a project's shell;
//   - a global concurrent-session cap, and an idle timeout that kills abandoned shells.
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { verifyAccessToken } from '../../lib/jwt';
import { prisma } from '../../lib/prisma';
import { isRole } from '../../lib/role';
import { ensureProjectDir, projectDirAbsolute } from '../../lib/caseStorage';
import { createTerminalSession } from '../../lib/terminalSession';
import { assertProjectVisible, type Viewer } from './projects.service';

/** Only this exact path is a terminal upgrade; the capture group is the project id. */
const TERMINAL_PATH_RE = /^\/api\/v1\/projects\/([A-Za-z0-9_-]+)\/terminal$/;

/** Live session count across the whole server, bounded by TERMINAL_MAX_SESSIONS. */
let sessionCount = 0;

/** A message from the browser terminal. */
interface ClientMessage {
  type: 'input' | 'resize';
  data?: string;
  cols?: number;
  rows?: number;
}

/** Reject a pre-handshake upgrade with a raw HTTP status, then close the socket. */
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  } catch {
    /* socket already gone */
  }
  socket.destroy();
}

/**
 * Read the bearer token from the Sec-WebSocket-Protocol header. The browser sends
 * `new WebSocket(url, ['bearer', <jwt>])`, so the header is `bearer, <jwt>`; a JWT is a
 * valid subprotocol token (no spaces/commas). Returns null when absent/malformed.
 */
function tokenFromProtocol(req: IncomingMessage): string | null {
  const header = req.headers['sec-websocket-protocol'];
  if (!header) return null;
  const parts = (Array.isArray(header) ? header.join(',') : header)
    .split(',')
    .map((part) => part.trim());
  const idx = parts.indexOf('bearer');
  return idx >= 0 && parts[idx + 1] ? parts[idx + 1] : null;
}

/**
 * Authenticate an upgrade: verify the access token, re-load the user (so a deleted or
 * disabled account is rejected even with a still-valid token), and check the viewer can
 * see the project. Returns the viewer on success, null on any failure (never throws).
 */
async function authenticate(req: IncomingMessage, projectId: string): Promise<Viewer | null> {
  const token = tokenFromProtocol(req);
  if (!token) return null;

  let sub: string;
  try {
    sub = verifyAccessToken(token).sub;
  } catch {
    return null;
  }

  const user = await prisma.user.findUnique({ where: { id: sub } }).catch(() => null);
  if (!user || !user.isActive || !isRole(user.role)) return null;

  const viewer: Viewer = { id: user.id, role: user.role };
  try {
    await assertProjectVisible(viewer, projectId);
  } catch {
    return null;
  }
  return viewer;
}

/**
 * Attach the terminal WebSocket gateway to the HTTP server. A no-op (and a clear log)
 * when the feature is disabled, so a pull-based deploy exposes nothing until an operator
 * opts in with TERMINAL_ENABLED=true.
 */
export function attachTerminalGateway(server: Server): void {
  if (env.TERMINAL_ENABLED !== 'true') {
    logger.info('Project terminal disabled (TERMINAL_ENABLED=false); no shell endpoint exposed.');
    return;
  }

  const wss = new WebSocketServer({
    noServer: true,
    // Select the 'bearer' subprotocol so the response never echoes the token value.
    handleProtocols: (protocols) => (protocols.has('bearer') ? 'bearer' : false),
  });
  logger.warn('Project terminal ENABLED: ws /api/v1/projects/:id/terminal runs a real shell.');

  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url ?? '').split('?')[0];
    const match = TERMINAL_PATH_RE.exec(pathname);
    if (!match) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    const projectId = match[1];

    const origin = req.headers.origin;
    if (origin && origin !== env.CORS_ORIGIN) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (sessionCount >= env.TERMINAL_MAX_SESSIONS) {
      rejectUpgrade(socket, 503, 'Terminal capacity reached');
      return;
    }

    void authenticate(req, projectId)
      .then((viewer) => {
        if (!viewer) {
          rejectUpgrade(socket, 401, 'Unauthorized');
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          void bridge(ws, projectId);
        });
      })
      .catch((err) => {
        logger.error('Terminal upgrade failed', err);
        rejectUpgrade(socket, 500, 'Internal Server Error');
      });
  });
}

/** Bridge an authenticated WebSocket to a shell session for `projectId`. */
async function bridge(ws: WebSocket, projectId: string): Promise<void> {
  sessionCount += 1;
  let closed = false;
  let idleTimer: NodeJS.Timeout | undefined;

  const cwd = await ensureProjectDir(projectId).catch(() => projectDirAbsolute(projectId));
  // Hand the shell the OpenFOAM bashrc path so the user can `source` it if they want the
  // CFD toolchain on PATH (kept explicit rather than auto-sourced).
  const extraEnv = env.OPENFOAM_BASHRC.trim()
    ? { OPENFOAM_BASHRC: env.OPENFOAM_BASHRC.trim() }
    : undefined;
  const session = createTerminalSession({ cwd, cols: 80, rows: 24, extraEnv });

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    sessionCount = Math.max(0, sessionCount - 1);
    session.kill();
    try {
      ws.close();
    } catch {
      /* already closing */
    }
  };

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      send({ type: 'exit', code: null, reason: 'idle-timeout' });
      cleanup();
    }, env.TERMINAL_IDLE_TIMEOUT_MS);
    idleTimer.unref();
  };

  const send = (payload: unknown) => {
    if (closed) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* socket gone */
    }
  };

  session.onData((data) => send({ type: 'output', data }));
  session.onExit((code) => {
    send({ type: 'exit', code });
    cleanup();
  });

  // Tell the client whether it got a real PTY or the piped fallback (affects UX hints).
  send({ type: 'ready', pty: session.pty });
  resetIdle();

  ws.on('message', (raw) => {
    resetIdle();
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      session.write(msg.data);
    } else if (
      msg.type === 'resize' &&
      typeof msg.cols === 'number' &&
      typeof msg.rows === 'number'
    ) {
      session.resize(msg.cols, msg.rows);
    }
  });
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

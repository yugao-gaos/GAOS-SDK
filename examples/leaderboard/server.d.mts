import type { Server } from 'node:http';

export function startLeaderboardServer(options: {
  database: string;
  objects: string;
  port?: number;
}): Server;

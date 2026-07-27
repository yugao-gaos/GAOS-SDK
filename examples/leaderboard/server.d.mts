import type { Server } from 'node:http';

export function startLeaderboardServer(options: {
  database: string;
  objects: string;
  port?: number;
}): Server;
export function databaseBoolean(database: string, value: boolean): 'TRUE' | 'FALSE' | '1' | '0';
export function normalizeDatabaseBoolean(value: unknown): boolean;
export function normalizeDatabaseJson(value: unknown): unknown;

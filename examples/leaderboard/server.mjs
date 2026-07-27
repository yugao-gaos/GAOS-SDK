import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

export function startLeaderboardServer({
  database,
  objects,
  port = 0,
} = {}) {
  if (!database || !objects) throw new TypeError('database and objects are required');
  const postgres = /^postgres(?:ql)?:\/\//.test(database);
  if (!postgres) mkdirSync(dirname(database), { recursive: true });
  mkdirSync(objects, { recursive: true });
  const schema = readFileSync(
    new URL(postgres ? './postgresql.sql' : './sqlite.sql', import.meta.url),
    'utf8',
  );
  sql(database, schema);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return response.end(readFileSync(new URL('./index.html', import.meta.url)));
      }
      if (request.method === 'POST' && url.pathname === '/api/submissions') {
        const body = JSON.parse(await readBody(request));
        const entry = body.entry;
        if (entry?.schema !== 'gaos.leaderboard-entry.v2'
          || typeof body.bundleBase64 !== 'string'
          || !/^[A-Za-z0-9._-]+$/.test(entry.artifactDigest)) {
          return json(response, 400, { error: 'invalid submission' });
        }
        const artifact = Buffer.from(body.bundleBase64, 'base64');
        const digest = createHash('sha256').update(artifact).digest('hex');
        if (entry.artifactDigest !== digest) {
          return json(response, 400, { error: 'artifact digest mismatch' });
        }
        assertEntry(entry);
        const pending = pendingVerification();
        writeFileSync(join(objects, entry.artifactDigest), artifact, { flag: 'wx' });
        const transaction = `BEGIN;
INSERT INTO benchmark_submissions VALUES (
${quote(entry.submissionId)},${quote(entry.benchmarkId)},${quote(entry.benchmarkVersion)},
${quote(entry.modality)},${quote(entry.agentName)},${Number(entry.aggregateScore)},
${entry.uncertainty == null ? 'NULL' : Number(entry.uncertainty)},${quote(entry.artifactDigest)},
${quote('unverifiable')},${databaseBoolean(database, false)},
${quote(JSON.stringify(pending))},NULL
);
${Object.entries(entry.taskScores).map(([task, score]) =>
    `INSERT INTO benchmark_task_scores VALUES (${quote(entry.submissionId)},${quote(task)},${Number(score)});`).join('\n')}
INSERT INTO verifier_queue(submission_id,artifact_digest) VALUES (
${quote(entry.submissionId)},${quote(entry.artifactDigest)});
COMMIT;`;
        sql(database, transaction);
        return json(response, 202, { submissionId: entry.submissionId, queued: true });
      }
      if (request.method === 'GET' && url.pathname === '/api/submissions') {
        const filters = [
          ['benchmarkId', 'benchmark_id'],
          ['benchmarkVersion', 'benchmark_version'],
          ['modality', 'modality'],
        ].flatMap(([parameter, column]) => {
          const value = url.searchParams.get(parameter);
          return value === null ? [] : [`${column}=${quote(value)}`];
        });
        const rows = sqlJson(database, `SELECT * FROM benchmark_submissions
${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
ORDER BY aggregate_score DESC, submission_id ASC;`);
        return json(response, 200, rows.map(row => rowToEntry(database, row)));
      }
      const match = url.pathname.match(/^\/api\/submissions\/([^/]+)(?:\/(artifact))?$/);
      if (request.method === 'GET' && match) {
        const id = decodeURIComponent(match[1]);
        const rows = sqlJson(database,
          `SELECT * FROM benchmark_submissions WHERE submission_id=${quote(id)};`);
        if (!rows.length) return json(response, 404, { error: 'not found' });
        if (match[2] === 'artifact') {
          const bytes = readFileSync(join(objects, rows[0].artifact_digest));
          response.writeHead(200, { 'content-type': 'application/octet-stream' });
          return response.end(bytes);
        }
        const entry = rowToEntry(database, rows[0]);
        return json(response, 200, {
          entry,
          artifactDownload: `/api/submissions/${encodeURIComponent(id)}/artifact`,
          localVerification: `gaos benchmark verify ${entry.artifactDigest}.gaos-bench`,
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/verifier/dequeue') {
        const rows = sqlJson(database,
          "SELECT * FROM verifier_queue WHERE status='pending' ORDER BY submission_id ASC LIMIT 1;");
        if (!rows.length) return json(response, 200, null);
        sql(database, `UPDATE verifier_queue SET status='running'
WHERE submission_id=${quote(rows[0].submission_id)};`);
        return json(response, 200, rows[0]);
      }
      if (request.method === 'POST' && url.pathname === '/api/verifier/complete') {
        const body = JSON.parse(await readBody(request));
        assertVerification(body.verification);
        if (!['trusted', 'unverifiable', 'rejected'].includes(body.evidenceVerdict)) {
          throw new TypeError('invalid evidence verdict');
        }
        const running = sqlJson(database, `SELECT submission_id FROM verifier_queue
WHERE submission_id=${quote(body.submissionId)} AND status='running';`);
        if (running.length !== 1) return json(response, 409, { error: 'job is not running' });
        sql(database, `BEGIN;
UPDATE benchmark_submissions SET
 evidence_verdict=${quote(body.evidenceVerdict)},
 reproduced=${databaseBoolean(database, body.reproduced === true)},
 verification_json=${quote(JSON.stringify(body.verification))},
 eligibility_json=${quote(JSON.stringify(body.eligibility ?? null))}
WHERE submission_id=${quote(body.submissionId)}
 AND EXISTS (SELECT 1 FROM verifier_queue WHERE submission_id=${quote(body.submissionId)} AND status='running');
UPDATE verifier_queue SET status='completed' WHERE submission_id=${quote(body.submissionId)} AND status='running';
COMMIT;`);
        return json(response, 200, { submissionId: body.submissionId, published: true });
      }
      return json(response, 404, { error: 'not found' });
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : 'request failed' });
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}

function sql(database, statement) {
  const postgres = /^postgres(?:ql)?:\/\//.test(database);
  const result = spawnSync(
    postgres ? (process.env.GAOS_PSQL ?? 'psql') : (process.env.GAOS_SQLITE3 ?? 'sqlite3'),
    postgres ? [database, '-v', 'ON_ERROR_STOP=1', '-At'] : [database], {
    input: statement,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'sqlite failed');
  return result.stdout;
}
function sqlJson(database, statement) {
  if (/^postgres(?:ql)?:\/\//.test(database)) {
    const trimmed = statement.trim();
    if (trimmed.includes(';') && !/^SELECT[\s\S]*;?$/i.test(trimmed)) {
      sql(database, statement);
      return [];
    }
    const query = trimmed.replace(/;$/, '');
    const output = sql(database, `SELECT COALESCE(json_agg(row_to_json(q)),'[]'::json) FROM (${query}) q;`);
    return JSON.parse(output.trim() || '[]');
  }
  const result = spawnSync(process.env.GAOS_SQLITE3 ?? 'sqlite3', ['-json', database], {
    input: statement,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'sqlite failed');
  return result.stdout.trim() ? JSON.parse(result.stdout) : [];
}
function rowToEntry(database, row) {
  const tasks = sqlJson(database, `SELECT task_id,score FROM benchmark_task_scores
WHERE submission_id=${quote(row.submission_id)} ORDER BY task_id;`);
  return {
    schema: 'gaos.leaderboard-entry.v2',
    submissionId: row.submission_id,
    benchmarkId: row.benchmark_id,
    benchmarkVersion: row.benchmark_version,
    modality: row.modality,
    agentName: row.agent_name,
    aggregateScore: row.aggregate_score,
    ...(row.uncertainty == null ? {} : { uncertainty: row.uncertainty }),
    artifactDigest: row.artifact_digest,
    evidenceVerdict: row.evidence_verdict,
    reproduced: normalizeDatabaseBoolean(row.reproduced),
    taskScores: Object.fromEntries(tasks.map(({ task_id, score }) => [task_id, score])),
    verification: normalizeDatabaseJson(row.verification_json),
    eligibility: normalizeDatabaseJson(row.eligibility_json),
  };
}
export function databaseBoolean(database, value) {
  return /^postgres(?:ql)?:\/\//.test(database)
    ? (value ? 'TRUE' : 'FALSE')
    : (value ? '1' : '0');
}
export function normalizeDatabaseBoolean(value) {
  return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
}
export function normalizeDatabaseJson(value) {
  if (value == null) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}
function assertEntry(entry) {
  if (!Number.isFinite(entry.aggregateScore)
    || (entry.uncertainty != null && !Number.isFinite(entry.uncertainty))
    || typeof entry.taskScores !== 'object'
    || Object.values(entry.taskScores).some(score => !Number.isFinite(score))) {
    throw new TypeError('scores must be finite');
  }
  assertVerification(entry.verification);
}
function assertVerification(verification) {
  const states = new Set(['verified', 'unverified', 'failed', 'not-required', 'not-observed']);
  const fields = [
    'replay', 'signatures', 'semantics', 'evidenceComplete',
    'organizerReproduced', 'implementationOpen', 'modelIdentityAttested',
    'hiddenTestCompliant', 'accountIdentityAttested', 'timeAttested',
    'publicationLogged', 'tailAnchored', 'availabilityObserved',
  ];
  if (fields.some(field => !states.has(verification?.[field]))
    || !Array.isArray(verification?.externalAuthorities)
    || !Array.isArray(verification?.reasons)) {
    throw new TypeError('invalid independent verification facts');
  }
}
function pendingVerification() {
  return {
    replay: 'not-observed', signatures: 'not-observed', semantics: 'not-observed',
    evidenceComplete: 'not-observed', organizerReproduced: 'not-observed',
    implementationOpen: 'not-observed', modelIdentityAttested: 'not-observed',
    hiddenTestCompliant: 'not-observed', accountIdentityAttested: 'not-observed',
    timeAttested: 'not-observed', publicationLogged: 'not-observed',
    tailAnchored: 'not-observed', availabilityObserved: 'not-observed',
    externalAuthorities: [], reasons: ['pending independent verification'],
  };
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 10_000_000) reject(new Error('request too large'));
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}
function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const currentDatabase = process.env.GAOS_DATABASE_URL ?? process.env.GAOS_DB ?? './leaderboard.sqlite';
  const server = startLeaderboardServer({
    database: currentDatabase,
    objects: process.env.GAOS_OBJECTS ?? './leaderboard-objects',
    port: Number(process.env.PORT ?? 8787),
  });
  server.on('listening', () => {
    process.stdout.write(`leaderboard listening on ${server.address().port}\n`);
  });
}

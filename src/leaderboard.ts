import type {
  LeaderboardEntryV2,
  SubmissionVerificationFacts,
} from './benchmark.js';
import { bytesToHex, sha256 } from './engine/commitment.js';

export interface LeaderboardObjectStore {
  put(digest: string, bytes: Uint8Array): Promise<void>;
  get(digest: string): Promise<Uint8Array | undefined>;
}

export interface LeaderboardVerifierQueue {
  enqueue(submissionId: string, artifactDigest: string): Promise<void>;
}

export interface LeaderboardQuery {
  benchmarkId?: string;
  benchmarkVersion?: string;
  modality?: string;
}

export interface LeaderboardSubmissionMetadata {
  entry: LeaderboardEntryV2;
  artifactDownload: string;
  localVerification: string;
}

/** Storage-neutral metadata API used by the deployable starter. */
export class LeaderboardService {
  private readonly entries = new Map<string, LeaderboardEntryV2>();

  constructor(
    private readonly objects: LeaderboardObjectStore,
    private readonly queue: LeaderboardVerifierQueue,
  ) {}

  async submit(entry: LeaderboardEntryV2, bundle: Uint8Array): Promise<void> {
    if (entry.schema !== 'gaos.leaderboard-entry.v2') {
      throw new TypeError('leaderboard submission requires the V2 schema');
    }
    assertIndependentVerificationFacts(entry.verification);
    if (entry.artifactDigest !== bytesToHex(sha256(bundle))) {
      throw new TypeError('artifact digest does not match submitted bundle bytes');
    }
    if (this.entries.has(entry.submissionId)) {
      throw new TypeError(`duplicate leaderboard submission ${entry.submissionId}`);
    }
    await this.objects.put(entry.artifactDigest, bundle.slice());
    this.entries.set(entry.submissionId, {
      ...structuredClone(entry),
      evidenceVerdict: 'unverifiable',
      reproduced: false,
      verification: pendingVerificationFacts(),
      eligibility: undefined,
    });
    await this.queue.enqueue(entry.submissionId, entry.artifactDigest);
  }

  list(query: LeaderboardQuery = {}): readonly LeaderboardEntryV2[] {
    return [...this.entries.values()]
      .filter((entry) =>
        (query.benchmarkId === undefined || entry.benchmarkId === query.benchmarkId)
        && (query.benchmarkVersion === undefined
          || entry.benchmarkVersion === query.benchmarkVersion)
        && (query.modality === undefined || entry.modality === query.modality))
      .sort((left, right) =>
        right.aggregateScore - left.aggregateScore
        || left.submissionId.localeCompare(right.submissionId))
      .map((entry) => structuredClone(entry));
  }

  metadata(submissionId: string): LeaderboardSubmissionMetadata | undefined {
    const entry = this.entries.get(submissionId);
    if (entry === undefined) return undefined;
    return {
      entry: structuredClone(entry),
      artifactDownload: `/api/submissions/${encodeURIComponent(submissionId)}/artifact`,
      localVerification: `gaos benchmark verify ${entry.artifactDigest}.gaos-bench`,
    };
  }

  async artifact(submissionId: string): Promise<Uint8Array | undefined> {
    const entry = this.entries.get(submissionId);
    if (entry === undefined) return undefined;
    return (await this.objects.get(entry.artifactDigest))?.slice();
  }
}

function pendingVerificationFacts(): SubmissionVerificationFacts {
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

export function assertIndependentVerificationFacts(
  facts: SubmissionVerificationFacts,
): void {
  const required = [
    'replay',
    'signatures',
    'semantics',
    'evidenceComplete',
    'organizerReproduced',
    'implementationOpen',
    'modelIdentityAttested',
    'hiddenTestCompliant',
    'accountIdentityAttested',
    'timeAttested',
    'publicationLogged',
    'tailAnchored',
    'availabilityObserved',
  ] as const;
  for (const field of required) {
    if (!['verified', 'unverified', 'failed', 'not-required', 'not-observed'].includes(
      facts[field],
    )) {
      throw new TypeError(`invalid independent verification fact ${field}`);
    }
  }
  if (!Array.isArray(facts.externalAuthorities) || !Array.isArray(facts.reasons)) {
    throw new TypeError('verification facts require authority results and reasons');
  }
}

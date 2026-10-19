/*
 * In-memory escrow store. Mirrors the state machine of the on-chain Soroban
 * escrow contract so the API can be used without a database. Data lives only
 * for the lifetime of the process (or serverless instance).
 */

export type ContractStatus =
  | 'Created'
  | 'Funded'
  | 'Completed'
  | 'Disputed'
  | 'Resolved'
  | 'Cancelled';

export interface Milestone {
  index: number;
  title: string;
  amount: number;
  released: boolean;
}

export interface Dispute {
  raisedBy: string;
  reason: string;
  openedAt: string;
  freelancerBps?: number;
  resolvedAt?: string;
}

export interface EscrowContract {
  id: number;
  title: string;
  client: string;
  freelancer: string;
  token: string;
  milestones: Milestone[];
  totalAmount: number;
  fundedAmount: number;
  releasedAmount: number;
  status: ContractStatus;
  reputationIssued: boolean;
  dispute?: Dispute;
  createdAt: string;
  updatedAt: string;
}

export interface Reputation {
  address: string;
  completedContracts: number;
  totalRating: number;
  averageRating: number;
}

export type ReviewRole = 'client_to_freelancer' | 'freelancer_to_client';

export interface Review {
  id: number;
  contractId: number;
  reviewer: string;
  reviewee: string;
  role: ReviewRole;
  rating: number;
  comment?: string;
  context?: 'disputed';
  createdAt: string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_MILESTONES = 20;
const ACTIVE: ContractStatus[] = ['Created', 'Funded'];

export class EscrowStore {
  private contracts = new Map<number, EscrowContract>();
  private reputation = new Map<string, { completed: number; total: number }>();
  private clientReputation = new Map<string, { completed: number; total: number }>();
  private reviews: Review[] = [];
  private nextReviewId = 1;
  private nextId = 1;

  list(filter: { status?: string; party?: string } = {}): EscrowContract[] {
    return [...this.contracts.values()].filter(
      (c) =>
        (!filter.status || c.status === filter.status) &&
        (!filter.party || c.client === filter.party || c.freelancer === filter.party),
    );
  }

  get(id: number): EscrowContract {
    const c = this.contracts.get(id);
    if (!c) throw new HttpError(404, 'contract_not_found', `Contract ${id} not found`);
    return c;
  }

  create(input: {
    title?: unknown;
    client?: unknown;
    freelancer?: unknown;
    token?: unknown;
    milestones?: unknown;
  }): EscrowContract {
    const { client, freelancer } = input;
    if (typeof client !== 'string' || typeof freelancer !== 'string' || !client || !freelancer) {
      throw new HttpError(400, 'invalid_parties', 'client and freelancer are required strings');
    }
    if (client === freelancer) {
      throw new HttpError(400, 'invalid_parties', 'client and freelancer must differ');
    }
    if (!Array.isArray(input.milestones) || input.milestones.length === 0) {
      throw new HttpError(400, 'invalid_milestones', 'milestones must be a non-empty array');
    }
    if (input.milestones.length > MAX_MILESTONES) {
      throw new HttpError(400, 'invalid_milestones', `at most ${MAX_MILESTONES} milestones`);
    }
    const milestones: Milestone[] = input.milestones.map((m: unknown, index: number) => {
      const raw = (typeof m === 'number' ? { amount: m } : m) as { title?: unknown; amount?: unknown };
      const amount = Number(raw?.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new HttpError(400, 'invalid_amount', `milestone ${index} amount must be positive`);
      }
      return {
        index,
        title: typeof raw.title === 'string' && raw.title ? raw.title : `Milestone ${index + 1}`,
        amount,
        released: false,
      };
    });
    const now = new Date().toISOString();
    const c: EscrowContract = {
      id: this.nextId++,
      title: typeof input.title === 'string' && input.title ? input.title : 'Untitled engagement',
      client,
      freelancer,
      token: typeof input.token === 'string' && input.token ? input.token : 'XLM',
      milestones,
      totalAmount: milestones.reduce((s, m) => s + m.amount, 0),
      fundedAmount: 0,
      releasedAmount: 0,
      status: 'Created',
      reputationIssued: false,
      createdAt: now,
      updatedAt: now,
    };
    this.contracts.set(c.id, c);
    return c;
  }

  private requireActive(c: EscrowContract) {
    if (!ACTIVE.includes(c.status)) {
      throw new HttpError(409, 'invalid_status', `Contract is ${c.status}`);
    }
  }

  private touch(c: EscrowContract) {
    c.updatedAt = new Date().toISOString();
    return c;
  }

  deposit(id: number, amountRaw: unknown): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new HttpError(400, 'invalid_amount', 'amount must be positive');
    }
    if (c.fundedAmount + amount > c.totalAmount) {
      throw new HttpError(409, 'over_funded', 'deposit exceeds contract total');
    }
    c.fundedAmount += amount;
    if (c.fundedAmount === c.totalAmount) c.status = 'Funded';
    return this.touch(c);
  }

  release(id: number, index: number): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    const m = c.milestones[index];
    if (!m) throw new HttpError(404, 'milestone_not_found', `Milestone ${index} not found`);
    if (m.released) throw new HttpError(409, 'already_released', 'Milestone already released');
    if (c.fundedAmount - c.releasedAmount < m.amount) {
      throw new HttpError(409, 'insufficient_funds', 'Escrow balance too low for this milestone');
    }
    m.released = true;
    c.releasedAmount += m.amount;
    if (c.milestones.every((x) => x.released)) c.status = 'Completed';
    return this.touch(c);
  }

  openDispute(id: number, raisedBy: unknown, reason: unknown): EscrowContract {
    const c = this.get(id);
    if (raisedBy !== c.client && raisedBy !== c.freelancer) {
      throw new HttpError(403, 'unauthorized', 'Only the client or freelancer can open a dispute');
    }
    this.requireActive(c);
    c.status = 'Disputed';
    c.dispute = {
      raisedBy,
      reason: typeof reason === 'string' && reason ? reason : 'No reason given',
      openedAt: new Date().toISOString(),
    };
    return this.touch(c);
  }

  resolveDispute(id: number, bpsRaw: unknown): EscrowContract {
    const c = this.get(id);
    if (c.status !== 'Disputed' || !c.dispute) {
      throw new HttpError(409, 'invalid_status', 'Contract is not disputed');
    }
    const Ops = Number(bpsRaw);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      throw new HttpError(400, 'invalid_split', 'freelancerBps must be an integer 0..10000');
    }
    const held = c.fundedAmount - c.releasedAmount;
    const toFreelancer = Math.floor((held * bps) / 10_000);
    c.releasedAmount += toFreelancer;
    c.fundedAmount = c.releasedAmount;
    c.status = 'Resolved';
    c.dispute.freelancerBps = bps;
    c.dispute.resolvedAt = new Date().toISOString();
    return this.touch(c);
  }

  cancel(id: number): EscrowContract {
    const c = this.get(id);
    this.requireActive(c);
    c.fundedAmount = c.releasedAmount;
    c.status = 'Cancelled';
    return this.touch(c);
  }

  private validateComment(commentRaw: unknown): string | undefined {
    if (commentRaw === undefined || commentRaw === null) return undefined;
    if (typeof commentRaw !== 'string') {
      throw new HttpError(400, 'invalid_comment', 'comment must be a string');
    }
    const trimmed = commentRaw.trim();
    if (trimmed.length > 1000) {
      throw new HttpError(400, 'invalid_comment', 'comment must be at most 1000 characters');
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw new HttpError(400, 'invalid_comment', 'comment must not contain control characters');
    }
    return trimmed.length ? trimmed : undefined;
  }

  private validateRating(ratingRaw: unknown): number {
    const rating = Number(ratingRaw);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new HttpError(400, 'invalid_rating', 'rating must be an integer 1..5');
    }
    return rating;
  }

  private applyReputation(
    map: Map<string, { completed: number; total: number }>,
    address: string,
    rating: number,
  ) {
    const r = map.get(address) ?? { completed: 0, total: 0 };
    r.completed += 1;
    r.total += rating;
    map.set(address, r);
  }

  createReview(
    id: number,
    input: { reviewer?: unknown; rating?: unknown; comment?: unknown },
  ): Review {
    const c = this.get(id);
    const { reviewer } = input;
    if (reviewer !== c.client && reviewer !== c.freelancer) {
      throw new HttpError(403, 'forbidden', 'Only the client or freelancer can review this contract');
    }
    if (c.status !== 'Completed' && c.status !== 'Resolved') {
      throw new HttpError(409, 'invalid_status', `Contract is ${c.status}`);
    }
    const role: ReviewRole =
      reviewer === c.client ? 'client_to_freelancer' : 'freelancer_to_client';
    if (this.reviews.some((r) => r.contractId === id && r.role === role)) {
      throw new HttpError(409, 'already_reviewed', 'Review already submitted for this direction');
    }
    const rating = this.validateRating(input.rating);
    const comment = this.validateComment(input.comment);
    const reviewee = role === 'client_to_freelancer' ? c.freelancer : c.client;
    const review: Review = {
      id: this.nextReviewId++,
      contractId: id,
      reviewer: reviewer as string,
      reviewee,
      role,
      rating,
      createdAt: new Date().toISOString(),
    };
    if (comment !== undefined) review.comment = comment;
    if (c.status === 'Resolved') review.context = 'disputed';
    this.reviews.push(review);
    if (role === 'client_to_freelancer') {
      this.applyReputation(this.reputation, c.freelancer, rating);
      c.reputationIssued = true;
    } else {
      this.applyReputation(this.clientReputation, c.client, rating);
    }
    this.touch(c);
    return review;
  }

  rate(id: number, ratingRaw: unknown): Reputation {
    const c = this.get(id);
    if (c.status !== 'Completed') {
      throw new HttpError(409, 'invalid_status', 'Only completed contracts can be rated');
    }
    if (c.reputationIssued) {
      throw new HttpError(409, 'already_rated', 'Reputation already issued for this contract');
    }
    const rating = this.validateRating(ratingRaw);
    this.createReview(id, { reviewer: c.client, rating });
    return this.getReputation(c.freelancer);
  }

  getReputation(address: string): Reputation {
    const r = this.reputation.get(address) ?? { completed: 0, total: 0 };
    return {
      address,
      completedContracts: r.completed,
      totalRating: r.total,
      averageRating: r.completed ? Math.round((r.total / r.completed) * 100) / 100 : 0,
    };
  }

  getReputationWithClient(address: string): Reputation & {
    asClient: { completedContracts: number; averageRating: number };
  } {
    const base = this.getReputation(address);
    const cr = this.clientReputation.get(address) ?? { completed: 0, total: 0 };
    return {
      ...base,
      asClient: {
        completedContracts: cr.completed,
        averageRating: cr.completed ? Math.round((cr.total / cr.completed) * 100) / 100 : 0,
      },
    };
  }

  listReviews(
    address: string,
    filter: { role?: string; limit?: number; cursor?: number } = {},
  ): { reviews: Review[]; nextCursor: number | null } {
    const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 100) : 20;
    const all = this.reviews
      .filter((r) => r.reviewee === address)
      .filter((r) => !filter.role || r.role === filter.role)
      .sort((a, b) => b.id - a.id);
    const start = filter.cursor ? all.findIndex((r) => r.id < filter.cursor !) : 0;
    const slice = all.slice(start < 0 ? 0 : start, start < 0 ? 0 : start + limit);
    const nextCursor = start < 0 ? null : start + limit < all.length ? slice[slice.length - 1]?.id ?? null : null;
    return { reviews: slice, nextCursor };
  }
}

import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';

describe('TalentTrust API', () => {
  const app = createApp(new EscrowStore());

  it('serves health and root', async () => {
    const h = await request(app).get('/health');
    expect(h.status).toBe(200);
    expect(h.body.status).toBe('ok');
    const root = await request(app).get('/');
    expect(root.status).toBe(200);
    expect(root.body.endpoints.length).toBeGreaterThan(5);
  });

  it('serves docs and openapi', async () => {
    expect((await request(app).get('/docs')).status).toBe(200);
    const spec = await request(app).get('/openapi.json');
    expect(spec.body.openapi).toBe('3.0.3');
  });

  it('runs the escrow lifecycle', async () => {
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }, { amount: 50 }] });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 150 })).body.status).toBe(
      'Funded',
    );
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);
    const done = await request(app).post(`/api/v1/contracts/${id}/milestones/1/release`).expect(200);
    expect(done.body.status).toBe('Completed');
    const rep = await request(app).post(`/api/v1/contracts/${id}/reputation`).send({ rating: 4 }).expect(200);
    expect(rep.body.averageRating).toBe(4);
  });

  it('supports two-sided reviews on a completed contract', async () => {
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GREVCLIENT', freelancer: 'GREVFREELANCER', milestones: [{ amount: 100 }] });
    const id = created.body.id;
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 100 }).expect(200);
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);

    const c2f = await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT', rating: 5, comment: '  Clear scope, fast payment  ' })
      .expect(201);
    expect(c2f.body.role).toBe('client_to_freelancer');
    expect(c2f.body.comment).toBe('Clear scope, fast payment');

    const f2c = await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVFREELANCER', rating: 4 })
      .expect(201);
    expect(f2c.body.role).toBe('freelancer_to_client');

    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT', rating: 3 })
      .expect(409);
    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GSTRANGER', rating: 3 })
      .expect(403);

    const clientRep = await request(app).get('/api/v1/reputation/GREVCLIENT').expect(200);
    expect(clientRep.body.asClient.completedContracts).toBe(1);
    expect(clientRep.body.asClient.averageRating).toBe(4);

    const feed = await request(app).get('/api/v1/reputation/GREVCLIENT/reviews').expect(200);
    expect(feed.body.reviews.length).toBe(1);
    expect(feed.body.reviews[0].role).toBe('freelancer_to_client');
  });

  it('rejects reviews on non-completed contracts and validates comments', async () => {
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GREVCLIENT2', freelancer: 'GREVFREELANCER2', milestones: [{ amount: 100 }] });
    const id = created.body.id;
    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT2', rating: 5 })
      .expect(409);
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 100 }).expect(200);
    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT2', rating: 5 })
      .expect(409);
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);
    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT2', rating: 5, comment: 'x'.repeat(1001) })
      .expect(400);
    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT2', rating: 5, comment: 'bad\u0007char' })
      .expect(400);
  });

  it('marks reviews of resolved contracts as disputed', async () => {
    const { body } = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GREVCLIENT3', freelancer: 'GREVFREELANCER3', milestones: [{ amount: 200 }] });
    await request(app).post(`/api/v1/contracts/${body.id}/deposit`).send({ amount: 200 }).expect(200);
    await request(app)
      .post(`/api/v1/contracts/${body.id}/dispute`)
      .send({ raisedBy: 'GREVFREELANCER3', reason: 'late' })
      .expect(200);
    await request(app).post(`/api/v1/contracts/${body.id}/resolve`).send({ freelancerBps: 5000 }).expect(200);
    const review = await request(app)
      .post(`/api/v1/contracts/${body.id}/reviews`)
      .send({ reviewer: 'GREVCLIENT3', rating: 2 })
      .expect(201);
    expect(review.body.context).toBe('disputed');
  });

  it('keeps the reputation endpoint backward compatible with reviews', async () => {
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GREVCLIENT4', freelancer: 'GREVFREELANCER4', milestones: [{ amount: 100 }] });
    const id = created.body.id;
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 100 }).expect(200);
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);
    const rep = await request(app).post(`/api/v1/contracts/${id}/reputation`).send({ rating: 5 }).expect(200);
    expect(rep.body.averageRating).toBe(5);
    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT4', rating: 5 })
      .expect(409);
  });

  it('rejects invalid input and unknown routes', async () => {
    await request(app).post('/api/v1/contracts').send({ client: 'GA', freelancer: 'GA', milestones: [1] }).expect(400);
    await request(app).get('/api/v1/contracts/999').expect(404);
    await request(app).get('/nope').expect(404);
  });

  it('handles disputes', async () => {
    const { body } = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GC', freelancer: 'GD', milestones: [{ amount: 200 }] });
    await request(app).post(`/api/v1/contracts/${body.id}/deposit`).send({ amount: 200 });
    await request(app).post(`/api/v1/contracts/${body.id}/dispute`).send({ raisedBy: 'GX' }).expect(403);
    await request(app).post(`/api/v1/contracts/${body.id}/dispute`).send({ raisedBy: 'GD', reason: 'late' }).expect(200);
    const r = await request(app).post(`/api/v1/contracts/${body.id}/resolve`).send({ freelancerBps: 5000 }).expect(200);
    expect(r.body.releasedAmount).toBe(100);
    expect(r.body.status).toBe('Resolved');
  });
});

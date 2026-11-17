import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { radarTestDatabase, seedRadarAccounts } from './radar-pg-fixture.js';
import { CustomerInvestmentsRepository } from './customer-investments.js';
import { CUSTOMER_INVESTMENTS_TABLES_SQL } from '../schema/customer-investments.js';
import { addPortfolio, emptyInvestmentState } from '../../services/investments/engine.js';

// Existing fixture refuses non-loopback or non-laboratory databases and creates its own disposable DB.
describe.skipIf(!process.env.ASTRA_RADAR_TEST_PORT)(
  'investment books actual PostgreSQL concurrency and isolation',
  () => {
    let fixture: Awaited<ReturnType<typeof radarTestDatabase>>;
    const userA = 'whatsapp:5567999991111',
      userB = 'whatsapp:5567999992222';
    const repo = (user = userA) =>
      Object.assign(new CustomerInvestmentsRepository(user), { adapter: fixture.adapter });
    const candidate = (id = 'a') =>
      addPortfolio(emptyInvestmentState(), { id, name: 'Carteira ' + id });
    beforeAll(async () => {
      fixture = await radarTestDatabase();
      await fixture.adapter.exec(CUSTOMER_INVESTMENTS_TABLES_SQL);
      await seedRadarAccounts(fixture.adapter);
    });
    beforeEach(async () => {
      await fixture.adapter.exec('TRUNCATE customer_investment_books');
    });
    afterAll(async () => {
      await fixture?.close();
    });
    it('returns independent empty accounts without seeding records', async () => {
      expect(await repo().get()).toEqual({ state: emptyInvestmentState(), storageVersion: 0 });
      expect(await fixture.adapter.query('SELECT user_id FROM customer_investment_books')).toEqual(
        []
      );
      await repo().save(candidate(), 0);
      expect((await repo(userB).get()).state.portfolios).toEqual([]);
    });
    it('serializes conflicting simultaneous first writes without losing either result silently', async () => {
      const results = await Promise.allSettled([
        repo().save(candidate('a'), 0),
        repo().save(candidate('b'), 0),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find(
        (result) => result.status === 'rejected'
      ) as PromiseRejectedResult;
      expect(failed.reason.status).toBe(409);
      expect((await repo().get()).storageVersion).toBe(1);
    });
    it('deduplicates identical concurrent writes and a lost-response retry', async () => {
      const value = candidate();
      const results = await Promise.all([repo().save(value, 0), repo().save(value, 0)]);
      expect(results.map((result) => result.storageVersion)).toEqual([1, 1]);
      expect((await repo().save(value, 0)).storageVersion).toBe(1);
    });
    it('increments storage version for market-only changes independently of economic revision', async () => {
      const first = await repo().save(candidate(), 0);
      const next = { ...first.state, marketRevision: 1 };
      const saved = await repo().save(next, 1);
      expect(saved.storageVersion).toBe(2);
      expect(saved.state.revision).toBe(first.state.revision);
      await expect(repo().save(candidate('stale'), 1)).rejects.toMatchObject({ status: 409 });
      expect(await repo().get()).toEqual(saved);
    });
    it('saves identical asset identifiers independently for different customers', async () => {
      await Promise.all([
        repo().save(candidate('same-id'), 0),
        repo(userB).save(candidate('same-id'), 0),
      ]);
      await repo().save(candidate('changed-a'), 1);
      expect((await repo(userB).get()).state.portfolios[0]?.id).toBe('same-id');
      expect((await repo().get()).state.portfolios[0]?.id).toBe('changed-a');
    });
    it('rolls back stale writes and rejects invalid data before provisioning a row', async () => {
      await expect(
        repo().save({ ...emptyInvestmentState(), operations: [{ id: 'invalid' }] }, 0)
      ).rejects.toThrow();
      expect(await fixture.adapter.query('SELECT user_id FROM customer_investment_books')).toEqual(
        []
      );
      await expect(repo().save(candidate(), 10)).rejects.toMatchObject({ status: 409 });
      expect(await fixture.adapter.query('SELECT user_id FROM customer_investment_books')).toEqual(
        []
      );
    });
  }
);

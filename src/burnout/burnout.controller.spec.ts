import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { BurnoutController } from './burnout.controller';
import { BurnoutRepository } from './burnout.repository';
import { type BurnoutDataset } from './burnout.types';

describe('Burnout HTTP dataset', () => {
  let app: INestApplication;
  let dataset: BurnoutDataset | null = null;
  let failed = false;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BurnoutController],
      providers: [
        {
          provide: BurnoutRepository,
          useValue: {
            latest: async () => {
              if (failed) throw new Error('Database unavailable');
              return dataset;
            },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('returns an explicit empty state without synthetic success data', async () => {
    const response = await request(app.getHttpServer()).get('/v1/burnout/dataset').expect(200);
    expect(response.body).toEqual({ state: 'empty' });
  });
  it('returns the authored scenario and zero factual coverage separately', async () => {
    dataset = {
      id: '6dca1f5e-16b9-49c2-b164-cadf2e73a615',
      periodStart: '2026-07-27',
      provenance: 'authored_scenario',
      employeeName: 'Сотрудник примера',
      sources: [],
      observations: [],
      weeklyScores: Array.from({ length: 8 }, () => ({
        exhaustion: 0,
        distance: 0,
        speechInconsistency: 0,
        workload: 0,
      })),
    };
    const response = await request(app.getHttpServer()).get('/v1/burnout/dataset').expect(200);
    expect(response.body).toMatchObject({
      state: 'ready',
      dataset: { coverage: { total: 0, accepted: 0, pending: 0, excluded: 0 } },
    });
  });
  it('does not mask a database failure as an empty dataset', async () => {
    failed = true;
    await request(app.getHttpServer()).get('/v1/burnout/dataset').expect(500);
  });
});

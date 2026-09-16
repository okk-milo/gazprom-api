import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { TechnicalController } from './technical.controller';
import { TechnicalRepository } from './technical.repository';
import { type TechnicalDataset } from './technical.types';

describe('Technical dataset HTTP', () => {
  let app: INestApplication,
    dataset: TechnicalDataset | null = null;
  let failed = false;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TechnicalController],
      providers: [
        {
          provide: TechnicalRepository,
          useValue: {
            latest: async () => {
              if (failed) throw new Error('Unavailable');
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
  it('returns an explicit empty state and no authored fallback', async () => {
    const response = await request(app.getHttpServer()).get('/v1/burnout/technical').expect(200);
    expect(response.body).toEqual({ state: 'empty', dataset: null });
  });
  it('maps measured facts to eight computed weeks and excludes model/private details', async () => {
    dataset = {
      id: 'ec74553e-2197-4e6c-aaf2-cfe165e783c2',
      version: 'technical-dialogue-v1',
      periodStart: '2026-07-27',
      sources: [
        {
          id: 'a'.repeat(64),
          status: 'measured',
          model: 'private-model',
          fingerprint: 'b'.repeat(64),
          facts: {
            durationSeconds: 120,
            speechMs: 60000,
            words: 100,
            segmentCount: 10,
            events: [],
          },
        },
      ],
    };
    const response = await request(app.getHttpServer()).get('/v1/burnout/technical').expect(200);
    expect(response.body).toMatchObject({
      state: 'ready',
      dataset: {
        ordering: 'score_sorted_conditional',
        coverage: { measured: 1 },
        overall: { index: 7.5 },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('private-model');
    expect(JSON.stringify(response.body)).not.toContain('fingerprint');
  });
  it('does not mask errors as successful zero scores', async () => {
    failed = true;
    await request(app.getHttpServer()).get('/v1/burnout/technical').expect(500);
    await request(app.getHttpServer()).get('/v1/burnout/report').expect(500);
    failed = false;
  });
  it('report waits for measured audio, then exposes a typed aggregate without private inputs', async () => {
    await request(app.getHttpServer())
      .get('/v1/burnout/report')
      .expect(200)
      .expect({ state: 'empty', dataset: null });
    const source = dataset?.sources[0];
    if (!source || source.status !== 'measured') throw new Error('Missing fixture');
    source.facts.audio = {
      version: 'silero-activity-v1',
      durationMs: 120000,
      voicedMs: 60000,
      longPauseMs: 4000,
      longPauseCount: 1,
    };
    const response = await request(app.getHttpServer()).get('/v1/burnout/report').expect(200);
    expect(response.body).toMatchObject({
      state: 'ready',
      dataset: {
        version: 'conversation-report-v2',
        coverage: { measured: 1 },
        overall: { values: { speechRate: 100, longPauses: 3.33 } },
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/private-model|fingerprint|quote|segmentId/);
  });
});

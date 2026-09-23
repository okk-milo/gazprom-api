import { EventEmitter } from 'node:events';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from './database.service';

const mockClient = Object.assign(new EventEmitter(), {
  query: jest.fn(),
  release: jest.fn(),
});
const mockPool = { connect: jest.fn(), query: jest.fn(), end: jest.fn() };
jest.mock('pg', () => ({ Pool: jest.fn(() => mockPool) }));

describe('DatabaseService worker lock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.removeAllListeners();
    mockPool.connect.mockResolvedValue(mockClient);
    mockClient.query.mockResolvedValue({ rows: [{ acquired: true }] });
    process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
  });
  it('holds a dedicated connection until release and releases idempotently', async () => {
    const database = new DatabaseService(new AppConfig());
    const lock = await database.tryAcquireLock(614001);
    expect(lock?.isHeld()).toBe(true);
    expect(mockClient.release).not.toHaveBeenCalled();
    await lock?.release();
    await lock?.release();
    expect(lock?.isHeld()).toBe(false);
    expect(mockClient.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [614001]);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
  it('does not become owner when another instance holds the lock', async () => {
    mockClient.query.mockResolvedValue({ rows: [{ acquired: false }] });
    const database = new DatabaseService(new AppConfig());
    await expect(database.tryAcquireLock(614001)).resolves.toBeNull();
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
  it('fails closed on connection loss and releases locks before pool shutdown', async () => {
    const database = new DatabaseService(new AppConfig());
    const lock = await database.tryAcquireLock(614001);
    mockClient.emit('error', new Error('private connection details'));
    expect(lock?.isHeld()).toBe(false);
    await database.onModuleDestroy();
    expect(mockClient.release).toHaveBeenCalledWith(true);
    expect(mockClient.query).toHaveBeenCalledTimes(1);
    expect(mockPool.end).toHaveBeenCalledTimes(1);
  });
});

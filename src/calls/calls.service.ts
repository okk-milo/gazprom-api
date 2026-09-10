import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../config/app-config';
import { StorageService } from '../storage/storage.service';
import { CallsRepository } from './calls.repository';
import { type CallSnapshot, type Deal, type Employee } from './calls.types';

@Injectable()
export class CallsService {
  constructor(
    private readonly repository: CallsRepository,
    private readonly storage: StorageService,
    private readonly config: AppConfig,
  ) {}

  async bootstrap(): Promise<void> {
    await this.repository.ensureDemoData();
  }

  async listEmployees(): Promise<Employee[]> {
    await this.bootstrap();
    return this.repository.listEmployees();
  }

  async createEmployee(name?: string): Promise<Employee> {
    return this.repository.createEmployee(name);
  }

  async deleteEmployee(employeeId: string): Promise<void> {
    const result = await this.repository.deleteEmployee(employeeId);

    if (result === 'not_found') {
      throw new NotFoundException('Сотрудник не найден');
    }

    if (result === 'in_use') {
      throw new ConflictException(
        'Нельзя удалить сотрудника, пока с ним связаны сделки или звонки.',
      );
    }
  }

  async listDeals(): Promise<Deal[]> {
    await this.bootstrap();
    return this.repository.listDeals();
  }

  async createDeal(employeeId: string, title: string): Promise<Deal> {
    return this.repository.createDeal(employeeId, title);
  }

  async createUpload(
    dealId: string,
    employeeId: string,
    fileName: string,
    contentType: string,
  ): Promise<{ call: CallSnapshot; uploadUrl: string | null }> {
    const sourceKey = `calls/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${this.safeFileName(fileName)}`;
    const call = await this.repository.createCall(
      dealId,
      employeeId,
      fileName,
      contentType,
      sourceKey,
    );
    const uploadUrl = await this.storage.createUploadUrl(sourceKey, contentType);

    if (!uploadUrl && !this.config.mockProcessingEnabled) {
      throw new Error('S3 storage is not configured');
    }

    return { call, uploadUrl };
  }

  async markUploaded(callId: string): Promise<CallSnapshot> {
    const call = await this.repository.markUploaded(callId);

    if (!call) {
      throw new NotFoundException('Звонок не найден');
    }

    return call;
  }

  async getSnapshot(callId: string): Promise<CallSnapshot> {
    const call = await this.repository.getCall(callId);

    if (!call) {
      throw new NotFoundException('Звонок не найден');
    }

    return call;
  }

  async getDownloadUrl(callId: string): Promise<string> {
    const sourceKey = await this.repository.getSourceKey(callId);

    if (!sourceKey) {
      throw new NotFoundException('Звонок не найден');
    }

    return this.storage.createDownloadUrl(sourceKey);
  }

  private safeFileName(fileName: string): string {
    return fileName.replace(/[^a-zA-Zа-яА-ЯёЁ0-9._-]/g, '_').slice(-160) || 'call-audio';
  }
}

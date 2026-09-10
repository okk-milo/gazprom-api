import { Injectable } from '@nestjs/common';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppConfig } from '../config/app-config';

@Injectable()
export class StorageService {
  private readonly client: S3Client | null;

  constructor(private readonly config: AppConfig) {
    this.client = config.storageConfigured
      ? new S3Client({
          endpoint: config.s3Endpoint,
          region: config.s3Region,
          credentials: {
            accessKeyId: config.s3AccessKeyId ?? '',
            secretAccessKey: config.s3SecretAccessKey ?? '',
          },
        })
      : null;
  }

  async createUploadUrl(key: string, contentType: string): Promise<string | null> {
    if (!this.client || !this.config.s3Bucket) {
      return null;
    }

    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.config.s3Bucket, Key: key, ContentType: contentType }),
      { expiresIn: 900 },
    );
  }

  async createDownloadUrl(key: string): Promise<string> {
    if (!this.client || !this.config.s3Bucket) {
      throw new Error('S3 storage is not configured');
    }

    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.config.s3Bucket, Key: key }),
      {
        expiresIn: 1800,
      },
    );
  }
}

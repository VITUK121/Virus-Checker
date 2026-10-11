import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as amqp from 'amqplib';
import * as crypto from 'crypto';
import * as fs from 'fs';

export interface ScanTaskResult {
  taskId: string;
  filename: string;
  filePath?: string;
  hash?: string;
  status: 'PENDING' | 'CLEAN' | 'INFECTED' | 'ERROR' | 'TIMEOUT' | 'FILE_NOT_FOUND';
  isInfected: boolean;
  virusName: string | null;
  details: string;
  isCached?: boolean;
  createdAt: Date;
  completedAt?: Date;
}

interface CacheEntry {
  status: 'CLEAN' | 'INFECTED' | 'ERROR' | 'TIMEOUT' | 'FILE_NOT_FOUND';
  isInfected: boolean;
  virusName: string | null;
  details: string;
  cachedAt: number;
}

@Injectable()
export class AppService implements OnModuleInit {
  private readonly logger = new Logger(AppService.name);
  private channel!: amqp.Channel;
  private tasks = new Map<string, ScanTaskResult>();
  private hashCache = new Map<string, CacheEntry>();

  // TTL: 24 hours for CLEAN files; infected files cached indefinitely
  private readonly CLEAN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  async onModuleInit() {
    try {
      const rmqUrl = process.env.RABBITMQ_URL || 'amqp://localhost';
      this.logger.log(`Connecting to RabbitMQ at ${rmqUrl}`);
      const connection = await amqp.connect(rmqUrl);
      this.channel = await connection.createChannel();
      
      await this.channel.assertQueue('scan_queue', { durable: true });
      await this.channel.assertQueue('results_queue', { durable: true });

      // Start consuming results from ClamAV worker
      this.channel.consume('results_queue', (msg) => {
        if (msg !== null) {
          try {
            const resultData = JSON.parse(msg.content.toString());
            this.logger.log(
              `Received scan result for task [${resultData.taskId}]: status=${resultData.status}`,
            );

            const existingTask = this.tasks.get(resultData.taskId);
            const fileHash = resultData.hash || existingTask?.hash;

            const updatedTask: ScanTaskResult = {
              ...(existingTask || {
                taskId: resultData.taskId,
                filename: resultData.filename || 'file',
                status: resultData.status,
                isInfected: resultData.isInfected,
                virusName: resultData.virusName,
                details: resultData.details,
                createdAt: new Date(),
              }),
              ...resultData,
              hash: fileHash,
              completedAt: new Date(),
            };

            this.tasks.set(resultData.taskId, updatedTask);

            // Cache valid scan results by file SHA-256 hash
            if (fileHash && (resultData.status === 'CLEAN' || resultData.status === 'INFECTED')) {
              this.hashCache.set(fileHash, {
                status: resultData.status,
                isInfected: resultData.isInfected,
                virusName: resultData.virusName,
                details: resultData.details,
                cachedAt: Date.now(),
              });
              this.logger.log(`Cached scan result for hash [${fileHash.slice(0, 12)}...]`);
            }

            this.channel.ack(msg);
          } catch (err) {
            this.logger.error('Error processing result message', err);
            this.channel.nack(msg, false, false);
          }
        }
      });
      this.logger.log('Listening for scan results on results_queue');
    } catch (err) {
      this.logger.error('Failed to initialize RabbitMQ connection in AppService', err);
    }
  }

  calculateFileHash(filePath: string): string {
    try {
      const fileBuffer = fs.readFileSync(filePath);
      return crypto.createHash('sha256').update(fileBuffer).digest('hex');
    } catch (err) {
      this.logger.error(`Failed to calculate SHA-256 hash for ${filePath}`, err);
      return '';
    }
  }

  processUploadedFile(diskFilePath: string, filename: string, originalFilename: string): ScanTaskResult {
    const fileHash = this.calculateFileHash(diskFilePath);
    const taskId = crypto.randomUUID();

    // 1. Check if hash exists in cache
    if (fileHash && this.hashCache.has(fileHash)) {
      const cached = this.hashCache.get(fileHash)!;
      const isExpired =
        cached.status === 'CLEAN' &&
        Date.now() - cached.cachedAt > this.CLEAN_CACHE_TTL_MS;

      if (!isExpired) {
        this.logger.log(
          `[⚡ Cache Hit] File "${originalFilename}" matches hash ${fileHash.slice(0, 12)}... Status: ${cached.status}`,
        );

        // Delete duplicate file on disk to save space
        try {
          if (fs.existsSync(diskFilePath)) {
            fs.unlinkSync(diskFilePath);
          }
        } catch (e) {
          this.logger.warn(`Could not remove cached duplicate file: ${diskFilePath}`);
        }

        const instantResult: ScanTaskResult = {
          taskId,
          filename: originalFilename,
          hash: fileHash,
          status: cached.status,
          isInfected: cached.isInfected,
          virusName: cached.virusName,
          details: `${cached.details}\n(⚡ Миттєва відповідь: результат отримано з кешу SHA-256)`,
          isCached: true,
          createdAt: new Date(),
          completedAt: new Date(),
        };

        this.tasks.set(taskId, instantResult);
        return instantResult;
      } else {
        this.logger.log(`[Cache Expired] Cache expired for hash ${fileHash.slice(0, 12)}... Rescanning.`);
        this.hashCache.delete(fileHash);
      }
    }

    // 2. Cache miss -> dispatch to RabbitMQ for ClamAV scanning
    const taskPayload = {
      taskId: taskId,
      filePath: `/app/uploads/${filename}`,
      originalName: originalFilename,
      hash: fileHash,
    };

    const pendingTask: ScanTaskResult = {
      taskId: taskId,
      filename: originalFilename,
      filePath: taskPayload.filePath,
      hash: fileHash,
      status: 'PENDING',
      isInfected: false,
      virusName: null,
      details: 'Scanning in progress...',
      isCached: false,
      createdAt: new Date(),
    };

    this.tasks.set(taskId, pendingTask);

    this.channel.sendToQueue(
      'scan_queue',
      Buffer.from(JSON.stringify(taskPayload)),
      { persistent: true },
    );

    this.logger.log(`[Queue Dispatched] Task [${taskId}] for file ${originalFilename} (Hash: ${fileHash.slice(0, 12)}...)`);
    return pendingTask;
  }

  getTaskStatus(taskId: string): ScanTaskResult | null {
    return this.tasks.get(taskId) || null;
  }
}



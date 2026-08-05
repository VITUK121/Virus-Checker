import { Injectable, OnModuleInit } from '@nestjs/common';
import * as amqp from 'amqplib';

@Injectable()
export class AppService implements OnModuleInit {
  private channel!: amqp.Channel;

  async onModuleInit() {
    // Підключення до RabbitMQ
    const connection = await amqp.connect(
      process.env.RABBITMQ_URL || 'amqp://localhost',
    );
    this.channel = await connection.createChannel();
    await this.channel.assertQueue('scan_queue', { durable: true });
  }

  publishToQueue(filename: string) {
    const taskId = crypto.randomUUID();
    const task = {
      taskId: taskId,
      filePath: `/app/uploads/${filename}`,
    };

    this.channel.sendToQueue('scan_queue', Buffer.from(JSON.stringify(task)), {
      persistent: true,
    });

    return taskId;
  }
}

import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { StackTrace } from 'cc-stacktracer';

/** Com app.enableShutdownHooks(): no SIGTERM o Nest fecha a app e chama isto antes de sair. */
@Injectable()
export class StackTraceShutdown implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await StackTrace.shutdown();
  }
}

import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { StackTraceShutdown } from './stacktrace.shutdown';

@Module({ controllers: [AppController], providers: [StackTraceShutdown] })
export class AppModule {}

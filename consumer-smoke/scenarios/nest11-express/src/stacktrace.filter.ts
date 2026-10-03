import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { StackTrace } from 'cc-stacktracer';

/** O Nest trata a exceção nos filtros, antes do Express/Fastify: a borda HTTP do SDK não a vê. */
@Catch()
export class StackTraceExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (process.env.FILTER === 'capture') {
      // O que o painel ensinava até a 3.2: o span raiz do 500 saía sem error_type, e o evento com status 0.
      const status = exception instanceof HttpException ? exception.getStatus() : 500;
      if (status >= 500 && exception instanceof Error) StackTrace.captureException(exception);
    } else {
      // A resposta decide: 5xx vira evento e vai para o span raiz; 4xx, não.
      StackTrace.recordRequestError(exception);
    }
    super.catch(exception, host);
  }
}

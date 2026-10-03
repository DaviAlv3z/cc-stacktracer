import { Controller, Get, Param } from '@nestjs/common';
import { StackTrace } from 'cc-stacktracer';

@Controller()
export class AppController {
  @Get('users/:id')
  async user(@Param('id') id: string): Promise<{ ok: boolean }> {
    StackTrace.setUser({ id: `u-${id}` });
    await new Promise((resolve) => setTimeout(resolve, 5 + (Number(id) % 7) * 3));
    StackTrace.log(`user ${id}`);
    return { ok: true };
  }

  @Get('boom')
  boom(): never {
    throw new Error('boom');
  }
}

/**
 * Envio cancelado pelo prazo do `shutdown()` ou da saída do processo. Não é falha de entrega: não vai
 * para o `onTransportError` e não gera aviso de perda.
 */
export class DeliveryCancelled extends Error {
  override readonly name = 'DeliveryCancelled';

  constructor() {
    super('cc-stacktracer: delivery cancelled at the shutdown/exit deadline');
  }
}

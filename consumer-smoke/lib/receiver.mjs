/**
 * Ingestão falsa do smoke de consumidor: guarda cada POST e responde como o servidor.
 *
 * `status` escolhe a resposta (202 por padrão). `statusSequence` responde os primeiros POSTs com esses status,
 * em ordem, e os demais com `status` — ex.: `[503]` é uma falha passageira seguida de sucesso. `body` é o JSON
 * das respostas de sucesso (ex.: um 202 com `rejectedIndexes`). `hang: true` aceita a conexão e nunca responde —
 * o balanceador travado que, até a 3.2, segurava o processo do cliente depois do `shutdown()`.
 *
 * `events()`/`spans()` só contam o que foi ACEITO (resposta 2xx): um lote que levou 503 e foi reenviado não
 * aparece duas vezes. `posts` guarda tudo, com o status respondido (`null` quando pendurado).
 */
import http from 'node:http';

export async function startReceiver({ status = 202, statusSequence = [], body = null, hang = false } = {}) {
  const posts = [];
  const sockets = new Set();
  const pending = [...statusSequence];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      const answer = pending.length > 0 ? pending.shift() : status;
      posts.push({ path: req.url ?? '', body: parsed, status: hang ? null : answer });
      if (hang) return;
      res.writeHead(answer, { 'content-type': 'application/json' });
      res.end(answer >= 400 ? JSON.stringify({ error: 'smoke', code: 'SMOKE' }) : JSON.stringify(body ?? {}));
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const accepted = () => posts.filter((p) => p.status !== null && p.status < 300);
  return {
    url: `http://127.0.0.1:${port}`,
    posts,
    events: () => accepted().flatMap((p) => (Array.isArray(p.body?.events) ? p.body.events : [])),
    spans: () => accepted().flatMap((p) => (Array.isArray(p.body?.spans) ? p.body.spans : [])),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

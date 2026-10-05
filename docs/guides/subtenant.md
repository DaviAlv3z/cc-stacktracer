# Subtenant — filtrar telemetria por cliente da sua aplicação

Se a sua aplicação é a mesma para N clientes — um helpdesk que atende dezenas de unidades, um ERP
multi-empresa, um SaaS com contas isoladas — o `subtenant` é o campo que separa a telemetria de cada
um deles dentro do mesmo projeto.

## Não confunda com `tenant_id`

São dois recortes diferentes, e só um é seu:

| Campo | O que é | Quem preenche |
|---|---|---|
| `tenant_id` | A organização dona da API key — **você**, o cliente da plataforma | O servidor, a partir da API key. Você nunca envia |
| `subtenant` | O cliente **da sua aplicação** — a "PM Demo" dentro do "Helpdesk" | Você, em cada envio |

## Não existe API para isto

Não há `withSubtenant()`, `setSubtenant()` nem nada parecido. Se um assistente de código sugerir uma,
ele inventou: vai quebrar em runtime. O que existe é a tag `subtenant` do escopo da requisição
(`setTags({ subtenant })`, abaixo), além do campo de payload em cada envio.

O `subtenant` é um **campo opcional de payload**. Você o inclui no envio, como incluiria qualquer
outro dado de contexto. Foi desenhado assim porque, numa aplicação multi-tenant de verdade, o cliente
só é conhecido depois da autenticação — às vezes depois de uma consulta ao banco. Uma API de escopo
exigiria o valor cedo demais.

## Onde o valor vai

### A requisição inteira (SDK 3.4)

Marque uma vez, logo depois da autenticação — no middleware de auth ou de tenant:

```ts
StackTrace.setUser({ id: String(user.id) });
StackTrace.setTags({ subtenant: cliente.slug });
```

Todo log e todo erro daquela requisição levam o valor (`tags.subtenant`, que o servidor lê como o campo de
payload). Com `init({ identityOnSpans: true })`, os spans também: o span raiz da requisição — lido quando ela
termina — e todo span criado depois da marcação (banco, chamadas de saída, `withSpan`). Num job, faça o mesmo
dentro do `withTrace`, que tem escopo próprio. Nunca chame `setTags({ subtenant })` fora de uma requisição ou
de um `withTrace`: ali ele vai para o escopo do processo inteiro.

### Erros e logs

```ts
import { StackTrace } from 'cc-stacktracer';

StackTrace.captureException(err, { subtenant: cliente.slug });
StackTrace.log('manifestação protocolada', { subtenant: cliente.slug });
```

### Spans

```ts
await StackTrace.withSpan(
  'processa-manifestacao',
  async () => {
    // ...
  },
  { attributes: { subtenant: cliente.slug } },
);
```

Note a ordem dos argumentos: `withSpan(nome, fn, options)`. A função vem **antes** das opções.

## Um span por requisição basta (antes da 3.4, ou sem `identityOnSpans`)

Esta é a parte que economiza a maior parte do trabalho.

O filtro da tela de traces seleciona uma trace se **qualquer** span dela casar, e então mostra a trace
**inteira**. Ou seja: um único span manual por requisição carregando o atributo torna toda a trace
filtrável — incluindo o span HTTP raiz e os spans de banco, que vieram da instrumentação automática e
não carregam o valor.

Você não precisa anotar span por span. Anote um, logo depois de resolver quem é o cliente.

```ts
// No handler, depois que o middleware já resolveu o tenant:
await StackTrace.withSpan('processa-manifestacao', () => serviço.processar(dados), {
  attributes: { subtenant: req.cliente.slug },
});
```

## O que não carrega o valor

Sem `identityOnSpans` (e nos SDKs anteriores à 3.4), os spans criados automaticamente pelo SDK — o HTTP raiz
do plugin de framework e os de banco do Prisma/Lucid — **nunca** têm o `subtenant`.

Com `identityOnSpans`, o span raiz leva o valor (ele é lido quando a requisição termina), e todo span criado
depois do `setTags({ subtenant })` também. O que continua sem: os spans que rodaram antes da marcação —
tipicamente as queries do próprio auth, que rodam antes de se saber quem é o cliente. Isso não é problema na
tela de traces, pela regra acima. Para pôr outros atributos no span raiz, use
`StackTrace.setRootSpanAttributes({ ... })`.

## Use slug, não id

```ts
{ subtenant: 'pm-demo' }                              // ✅
{ subtenant: 'f2418f5f-c776-4a1e-9c3d-2b8e4a91d077' }    // ❌
```

Dois motivos:

1. **O valor aparece cru** no seletor de filtro e nas telas. `pm-demo` é legível; um UUID é um
   enigma para quem está olhando o painel.
2. **Cardinalidade.** A coluna é otimizada para poucos valores distintos. Slug de município fica nas
   centenas e vai bem. Id de registro, de sessão ou de usuário estoura — e a auditoria de
   instrumentação avisa com o alerta `subtenant_cardinality` quando isso começa a acontecer.

Se o valor que você tem em mãos é um id, derive um slug estável dele uma vez e reutilize.

## Conferindo

Depois do primeiro envio, abra `/traces`, `/errors` ou `/explorer`: o seletor **Subtenant** aparece
assim que existir pelo menos um valor na janela observada. Enquanto não houver nenhum, ele fica
escondido — então se você não o vê, o dado ainda não chegou.

O `/dashboard` **não** tem esse filtro, de propósito: ele conta o projeto inteiro, para não divergir
do motor de alertas.

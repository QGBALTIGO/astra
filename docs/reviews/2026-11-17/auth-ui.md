# Autenticação, isolamento administrativo e interface do cliente

Data da revisão: 2026-11-17. Base inicial: `7915ecdd9933b55183b511f5718030b1d34e5304`.

Este registro descreve a frente de autenticação e interface, seus testes locais e a revisão integrada realizada no candidato `audit/member-readiness-20261117`. Os gates gerais, a classificação final de severidade e a decisão de publicação pertencem ao relatório principal `docs/ASTRA_MEMBER_READINESS_2026-11-17.md`.

Último head de código verificado nesta nota: `43118c019e3d08bc3adea9f4887481c09fe4ee48`, árvore `3947f33a813cc38514b0a6f27013811e48549289`. A sequência de CI abaixo preserva a identidade de cada execução e da amostra visual anterior.

## Escopo e limites de execução

- Revisão manual de código, regressões unitárias e integração HTTP em processo com PostgreSQL real isolado. O scanner não foi executado: seus recursos auxiliares não estavam disponíveis. A indisponibilidade de DFMT foi comunicada pelo coordenador e o trabalho usou as ferramentas de execução disponíveis.
- Nenhuma alteração em produção, mensagem real de WhatsApp, tentativa de bypass em produção, pagamento real ou consumo de credenciais de clientes.
- A configuração efetiva de `AUTH_TYPE` em produção não foi obtida. O coordenador observou, em leitura, que havia senha de painel configurada; isso não basta para afirmar que o modo vulnerável estava ativo.
- O teste HTTP usa Hono em processo. O teste WebSocket verifica autorização e upgrade com sockets simulados. Não equivale a teste externo completo do serviço implantado.
- A revisão inicial do painel e da landing foi estática: o Chromium local falhou ao criar sockets e a alternativa de download não ficou disponível. Posteriormente, os testes Playwright em CI e a inspeção de dez capturas originais acrescentaram a evidência de navegador descrita abaixo; não houve navegação autenticada em produção.

## Achados corrigidos

| Achado                                        | Condição e impacto comprovados localmente                                                                                                                                                                                                                                                                                                                                                                                                                                        | Correção e evidência                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bypass administrativo HTTP e WebSocket        | Com senha do painel configurada e autenticação API resolvida como `none`, um header `Authorization` ou `X-API-Key` arbitrário deixava a requisição HTTP seguir; o WebSocket também aceitava conexão sem sessão do proprietário. No cenário reproduzido, não havia outro autenticador API para validar o header. Impacto administrativo alto; exposição dessa configuração em produção desconhecida. O relatório principal classifica a prioridade segundo o critério do usuário. | `middleware/ui-session.ts` recebe `apiAuthEnabled`; `app.ts` o deriva do modo real. Headers somente delegam quando existe autenticação API habilitada. `ws/server.ts` exige sessão do proprietário quando há senha, mesmo com API `none`. Dez novas regressões falhavam antes da correção: quatro HTTP, quatro WebSocket nessa configuração, uma API-key sem chaves e uma de cookie malformado. |
| WebSocket com modo API-key sem chaves         | A configuração explícita de API-key com lista vazia falhava aberta.                                                                                                                                                                                                                                                                                                                                                                                                              | O modo explícito agora falha fechado. Uma sessão válida do proprietário continua sendo uma credencial válida.                                                                                                                                                                                                                                                                                   |
| Cookie WebSocket malformado                   | Um cookie de sessão com escape inválido gerava `URIError` no fluxo de upgrade. Não foi demonstrado crash do processo.                                                                                                                                                                                                                                                                                                                                                            | A decodificação captura o erro e rejeita a credencial; o teste verifica resposta 401 e encerramento do socket sem rejeição não tratada do handler.                                                                                                                                                                                                                                              |
| Retenção de OTP expirado offline              | O ciphertext de um desafio expirado podia permanecer enquanto o transporte estava offline.                                                                                                                                                                                                                                                                                                                                                                                       | A limpeza roda no dispatcher antes de exigir conexão/segredo, no máximo uma vez por minuto, anula ciphertext e lease expirados, cancela entregas pendentes e preserva o registro e as tentativas. Um índice parcial limita a busca a desafios com ciphertext. Teste PostgreSQL verifica preservação da cota de solicitações.                                                                    |
| Resposta HTTP cancelada afetando outra sessão | Uma resposta antiga cancelada durante a leitura do corpo podia devolver dados ou disparar o evento global de sessão expirada. Isso podia derrubar a conta atualmente aberta.                                                                                                                                                                                                                                                                                                     | A API do cliente respeita o sinal após fetch e após a leitura do corpo, preserva `AbortError` e não publica dados nem evento de logout de uma chamada cancelada. Três regressões falhavam antes e passaram depois.                                                                                                                                                                              |

O modo local documentado sem senha permanece disponível sob a configuração existente de proprietário implícito. O patch não transforma uma sessão de cliente em credencial administrativa e preserva a separação entre o namespace público/de autenticação do cliente e os guards do proprietário.

## Inventário de alterações desta frente

Os caminhos abaixo são relativos à raiz do repositório.

| Área                                                     | Arquivos                                                                                                                                                                                  | Finalidade                                                                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guard HTTP                                               | `packages/gateway/src/middleware/ui-session.ts`, `ui-session.test.ts`; `packages/gateway/src/app.ts`, `app.test.ts`                                                                       | Vincular a delegação por header à autenticação API realmente habilitada; preservar whitelist pública e de clientes.                                                                       |
| Guard WebSocket                                          | `packages/gateway/src/ws/server.ts`, `server.test.ts`                                                                                                                                     | Exigir credencial administrativa válida; falhar fechado com API-key vazia e cookie inválido.                                                                                              |
| Desafios OTP                                             | `packages/gateway/src/db/repositories/customer-auth.ts`; `packages/gateway/src/services/customer-auth.ts`, `customer-auth.test.ts`; `packages/gateway/src/db/schema/customer-accounts.ts` | Eliminar ciphertext expirado sem apagar histórico de tentativas e limites.                                                                                                                |
| Integração PostgreSQL                                    | `packages/gateway/src/db/repositories/customer-auth.pg.test.ts`                                                                                                                           | Exercitar autenticação, sessões e separação de três contas reais no banco isolado.                                                                                                        |
| API do painel cliente                                    | `packages/ui/src/pages/customer/api.ts`, `api.test.ts`                                                                                                                                    | Impedir dados/eventos atrasados de chamadas canceladas.                                                                                                                                   |
| Confirmações de metas, transferidas pela frente de dados | `packages/gateway/src/channels/response-safety.ts`, `verified-facts.ts`, `verified-facts.test.ts`                                                                                         | Manter confirmação persistida após falha do modelo e compor respostas mistas sem números inventados. Os demais trechos de metas nesses arquivos foram implementados pela frente de dados. |

## Evidência de testes

### Baseline e reprodução

| Execução                                              | Resultado observado                             | Log local                      |
| ----------------------------------------------------- | ----------------------------------------------- | ------------------------------ |
| Baseline focal HTTP, serviços e rotas de autenticação | 6 arquivos; 243 testes aprovados                | `auth-baseline.log`            |
| Baseline WebSocket                                    | 1 arquivo; 158 testes aprovados                 | `auth-ws-baseline.log`         |
| Regressões administrativas e cookie antes do patch    | 10 falhas; 179 testes aprovados                 | `auth-reproduction.log`        |
| Limpeza de OTP antes do patch, execução filtrada      | 1 falha de reprodução; 14 testes fora do filtro | `auth-expiry-reproduction.log` |
| Baseline da interface de autenticação                 | 4 arquivos; 33 testes aprovados                 | `ui-auth-baseline.log`         |
| API cancelada antes do patch                          | 3 falhas; 16 testes aprovados                   | `ui-api-reproduction.log`      |

### Resultado focal final

- Backend: **8 arquivos, 432 testes aprovados, sem skips**, incluindo **15 testes com PostgreSQL 16.4 real**. Log `auth-final-focused.log`; o wrapper registrou `ISOLATED_TEST_EXIT 0`.
- Interface: **4 arquivos, 36 testes aprovados**. Log `ui-auth-fixed.log`.
- ESLint dos onze arquivos de backend e dos dois arquivos de interface aprovou; `git diff --check` aprovou no término dessa frente.
- A saída de Vitest informou ausência de erros de tipos no escopo executado. Isso não substitui o build e o typecheck completos coordenados separadamente.

Os logs citados foram produzidos sob `/workspace/scratch/79eb9d8781db/`. São evidências da sessão local, não artefatos persistentes de CI. Não se somam aos totais gerais sem deduplicação de suítes.

Comando para reproduzir a integração PostgreSQL de autenticação com banco isolado:

```sh
node /workspace/scratch/79eb9d8781db/with-review-db.mjs corepack pnpm --filter @ownpilot/gateway exec vitest run src/db/repositories/customer-auth.pg.test.ts --maxWorkers=2
```

O wrapper inicia e encerra um cluster descartável no mesmo processo de execução, condição necessária neste executor. A porta é dinâmica. Uma tentativa anterior de fixture não deve ser contabilizada como execução dos casos que ficaram sem rodar. O código de saída do wrapper foi corrigido e verificado pela coordenação antes do resultado final citado.

### Cobertura PostgreSQL de autenticação

Os quinze testes verificam:

- Três logins independentes, cookies `HttpOnly`, `Secure`, `SameSite=Lax`, escopo `/api/v1/customer`, tokens não expostos no JSON e apenas hashes persistidos.
- Perfil e lista de sessões determinados pela sessão autenticada, inclusive com IDs de outra conta enviados pelo cliente.
- As seis combinações de revogação entre contas são recusadas, sem invalidar a sessão do alvo; injeção de identidade e origem CSRF inválida não alteram outros perfis.
- As três sessões de cliente são recusadas na API administrativa, mesmo acompanhadas de headers inventados. Um caminho administrativo dentro do namespace cliente termina em 404.
- Doze verificações simultâneas de um OTP geram exatamente uma sessão. Doze palpites incorretos respeitam o teto de cinco e invalidam o código, inclusive quando o valor correto é enviado depois.
- Resend simultâneo entre duas instâncias respeita cooldown e invalida o desafio substituído; OTP vence em cinco minutos.
- Telefones desconhecidos e o telefone do proprietário têm resposta genérica e não recebem conta ou sessão de cliente; token forjado não autentica.
- Limpeza de ciphertext expirado funciona offline e preserva tentativas e cota; logout e revogação são persistentes e limitados à própria conta.
- Sessões existentes são recusadas após bloqueio, revogação da verificação ou troca da versão de autenticação. Conta aprovada com acesso vencido mantém leitura e não pode transferir telefone.

### Segurança dos dados de teste

`customer-auth.pg.test.ts` reutiliza `radar-pg-fixture.ts`. O fixture conecta apenas a `127.0.0.1`, exige porta de teste válida, usa role `astratest`, base `astratest_radar` e senha fictícia de laboratório. Confere role/base antes de criar um banco `radar_lab_<UUID>` e só remove o banco aleatório que criou. O nome é validado antes do DROP.

O teste injeta explicitamente esse adapter nos repositórios. O `TRUNCATE ... CASCADE` ocorre apenas no banco aleatório do fixture. Telefones, segredo, OTP e dados de perfil são sintéticos. O transporte retorna lista vazia e nenhuma instância de canal; a suite não tem caminho de entrega real. As requisições a `https://astra.test` usam `app.request` do Hono, sem conexão externa. Não há leitura de URL PostgreSQL de produção nem fallback de credencial nesse fixture.

## Revisão estática do painel e da landing

Foram conferidos login, portal, formulários, sincronização e estilos. O login possui trava de submissão por referência, tratamento de erros e TTL/retry do OTP; o código permanece texto para preservar zeros iniciais. Formulários relevantes também bloqueiam submissão duplicada e respeitam `canWrite`.

O portal troca a árvore por identidade de conta, revalida sessão no foco/visibilidade e periodicamente, reflete a expiração de escrita e atualiza revisões financeiras com cancelamento. A correção da API cancela a propagação de dados/eventos das respostas antigas. CSS contém breakpoints e uso de áreas seguras/dvh; isso foi inspeção de código, não medição de layout renderizado.

A landing informa preço de R$ 19,90, teste de três dias e ausência de cobrança automática após o teste; identifica demonstrações como ilustrativas. Não foi encontrada promessa de Open Finance ou de centenas de integrações no conteúdo revisado. Esta leitura não valida preço, checkout ou catálogo comercial em serviços externos. A frente inicial de autenticação/UI não alterou aparência, textos comerciais ou arquivos TSX/CSS. Posteriormente, a coordenação corrigiu a promessa de recorrência da landing e o plural do Radar; essas mudanças constam no relatório integrado.

## Revisão integrada de metas

Foram lidos `customer-planning-tools.ts`, o repositório e schema de `customer_goal_requests`, seleção de ferramentas, whitelist e prompt do agente, receipts e testes PostgreSQL de metas. Não foram encontrados novos escapes de identidade nessa leitura:

- O executor obtém a conta pelo `dataUserId` autenticado, rejeita o proprietário `default` para metas de membros e usa schemas estritos que não aceitam um `userId` arbitrário nos argumentos.
- Get/update/delete filtram pelo usuário; o tipo `goal` é conferido para impedir conversão de uma assinatura por ID. A permissão é revalidada após o lock por usuário antes da escrita.
- Pedido idempotente e alteração ficam na mesma transação. Fingerprint diferente com a mesma chave causa conflito. Replays consultam o estado atual e não recriam uma meta excluída.
- A whitelist remove escritores legados de metas percentuais do registro disponível a clientes, inclusive para descoberta via meta-tools, preservando leituras legadas. O prompt distingue reais, total guardado e percentual.

Na integração de apresentação foram reproduzidas duas classes de falha: confirmação de uma meta persistida sumia após falha da finalização do modelo; respostas compostas podiam omitir a meta ou conservar um valor inventado. Cinco novos casos falharam antes da correção, com quinze testes existentes aprovados (`goal-confirmation-reproduction.log`).

A correção inclui metas comprovadas em `verifiedWriteDetails`, conserva falhas como falhas e compõe cada outra operação pelo formatter existente, usando apenas seus receipts. Meta com clima, meta com consulta e meta/tarefa/clima não reaproveitam os números do texto do modelo. Para uma consulta sem formatter comprovado, a resposta comunica a limitação dessa parte e preserva a meta; não inventa resumo. A bateria focal de quatro arquivos aprovou **173 testes** (`goal-confirmation-fixed.log`).

## Outras leituras integradas

- Cakto: foi identificado e encaminhado à frente responsável um retry após commit que perdia o outcome `held_*` persistido e podia apagar a evidência pendente depois de uma falha de gravação no armazenamento. O agente responsável reproduziu e corrigiu; seus testes e a retenção de evidências pertencem ao relatório de pagamentos.
- Adapter PostgreSQL: a remoção do retry SQL implícito é coerente com o risco de commit seguido de perda da resposta. `query()` também pode escrever; nenhuma das APIs deve reexecutar automaticamente. A leitura do patch e dos testes confirmou propagação da incerteza e uso do pool numa requisição independente posterior. Não foram repetidos os testes aprovados da coordenação.
- Shutdown de canais: o trecho novo acompanha turns aceitos, inclui os recebidos durante a drenagem e limita o tempo de desconexão/flush de credenciais. Trabalho que excede o timeout permanece incerto; isso não equivale a replay durável após hard crash, coordenação distribuída ou drenagem de todos os envios de todos os workers. Nenhuma validação externa foi realizada nesta leitura.

## CI do candidato integrado e inspeção visual

O [CI 44158009253](https://github.com/QGBALTIGO/astra/actions/runs/44158009253) terminou com **success em 2026-11-17 às 19:31:14 UTC**, no head `3e50657ffbc4bbef13c6239b9242471937af1c4b`, árvore `110af807ce183a2801dafcd43f770b0338482583`. Os cinco jobs executados aprovaram: Linux, Windows, Playwright, migração pgvector/PG16 e boot do gateway. O job `Coverage report` foi ignorado pela condição do workflow; não é uma aprovação de cobertura. O [Dashboard release 44158009324](https://github.com/QGBALTIGO/astra/actions/runs/44158009324), no mesmo head, também terminou com success; as evidências de backup/restore estão em `infrastructure.md`.

| Gate                                   | Resultado terminal observado                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Linux — gateway                        | 605 arquivos aprovados e 26 ignorados; 23.483 testes aprovados e 1.297 ignorados.                                        |
| Linux — core                           | 164 arquivos; 10.039 testes aprovados e 3 ignorados.                                                                     |
| Linux — UI                             | 139 arquivos; 2.400 testes aprovados e 1 ignorado.                                                                       |
| Linux — CLI                            | 14 arquivos; 438 testes aprovados.                                                                                       |
| Linux — recuperação/delivery com banco | Etapa separada: 9 arquivos, 107 testes aprovados.                                                                        |
| Linux — ferramentas                    | Build, typecheck, lint e format check aprovados; Prettier informou todos os arquivos conformes.                          |
| Windows                                | Build, typecheck e lint aprovados; core 10.039 aprovados/3 ignorados, UI 2.400 aprovados/1 ignorado e CLI 438 aprovados. |
| Playwright, imagem oficial             | 175 testes aprovados em 2,6 minutos.                                                                                     |

Estas contagens pertencem às respectivas execuções; não representam testes únicos somados entre plataformas ou suites focais. O log Playwright contém avisos `ws proxy socket error: write EPIPE`, sem teste ou etapa falhando. O resultado aprovado não determina a causa desses avisos.

### Artefato e amostra visual

O artifact [whatsapp-access-ui, 14362866223](https://github.com/QGBALTIGO/astra/actions/runs/44158009253/artifacts/14362866223) contém 44 PNGs. O ZIP baixado tem 3.697.769 bytes; seu SHA-256 conferido é `02286a3b2397cffe4bce705188d9829cca7081a459b72ae3192cb5b0cf85c6b6`. A extração foi limitada ao diretório local da revisão, com validação de caminhos. As imagens foram abertas diretamente, sem edição, recorte ou regeneração.

Foram inspecionadas dez capturas. Os testes do portal usam viewport desktop de 1440 × 1000 e móvel de 390 × 844; o cenário de header também captura 320 px. Capturas de página inteira podem ser mais altas que a viewport, mantendo componentes fixos na posição da viewport original.

| Capturas inspecionadas                                                                                        | Observação visual                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whatsapp-access-customer-mobile-login.png`, `whatsapp-access-customer-desktop-login.png`                     | Formulário de telefone com país, campo, instruções e CTA visíveis. Foco do campo perceptível. Não houve corte de texto ou sobreposição que impedisse o acesso nos tamanhos capturados.                                                                     |
| `whatsapp-access-customer-mobile-expired-profile.png`, `whatsapp-access-customer-desktop-expired-profile.png` | Modal de exportação legível, botões CSV/JSON e fechar visíveis, toast de exportação preparada. O fundo está desfocado; o estado expirado e a recusa de escrita são comprovados pelas asserções do teste, não pela leitura visual do banner atrás do modal. |
| `whatsapp-access-customer-header-mobile-320-light-photo.png`                                                  | Marca e quatro controles do header cabem em 320 px, sem sobreposição visível. A captura só inclui o header.                                                                                                                                                |
| `whatsapp-access-customer-mobile-home.png`                                                                    | Resumo financeiro, ações e navegação móvel renderizados; textos e cartões da página inteira legíveis. A navegação fixa aparece sobre a região rolável na altura da viewport original.                                                                      |
| `whatsapp-access-mobile-modal.png`, `whatsapp-access-desktop-modal.png`                                       | Autorização administrativa mostra telefone normalizado, nome, opções de prazo e ações de confirmar/cancelar. Os controles estão visíveis nos dois tamanhos.                                                                                                |
| `whatsapp-access-mobile.png`                                                                                  | Toast de número autorizado e registro novo na lista estão visíveis. A captura é da viewport; não comprova visualmente itens fora dela.                                                                                                                     |
| `whatsapp-access-WhatsApp-a-9a9bd-es-an-optional-renewal-link-chromium/whatsapp-access-messages.png`          | Modal móvel mostra site, link de renovação opcional, explicação do fallback, fuso e botões. Não há corte impeditivo dos controles observados.                                                                                                              |

Não foi observado bloqueio visual concreto nessa amostra. Isso não é inspeção manual de todas as 44 imagens, nem aprovação de todos os navegadores ou estados possíveis. As demais capturas da matriz de membros foram revisadas separadamente pela coordenação.

### Alcance dos testes de login e expiração

`packages/ui/e2e/customer-portal.spec.ts` usa `mockCustomerApi`: as requisições do navegador têm respostas controladas com dados sintéticos. O teste aprovado exercita solicitação do código, reenvio desabilitado no cooldown, rejeição de `000000`, preservação do campo, aceite de `123456`, entrada no portal, cinco abas e ausência de credenciais administrativas. As contagens esperadas são uma solicitação e duas verificações do código.

**Não há captura da tela de OTP nesse artifact.** As imagens com sufixo `login` foram feitas antes de solicitar o código, ainda no formulário de telefone. A evidência da etapa OTP é funcional, pelas asserções Playwright aprovadas, e não visual. A entrega real por WhatsApp e o backend de autenticação não são exercitados por esse mock; a evidência independente de PostgreSQL e guards está nas seções anteriores.

O teste de expiração também usa o mock: confirma recuperação de uma falha de leitura, desabilita criação de transação/categoria/compromisso e alteração de telefone, mantém preferências e exportação disponíveis, confirma download JSON e ausência de mutações. Não é renovação real, exportação de uma conta de produção nem teste de pagamento externo.

### Revalidação intermediária após plural e contador

O [CI 44159910672](https://github.com/QGBALTIGO/astra/actions/runs/44159910672) terminou com **success às 19:41:03 UTC**, e o [Dashboard release 44159910780](https://github.com/QGBALTIGO/astra/actions/runs/44159910780) terminou com **success às 19:35:48 UTC**, ambos em 2026-11-17 no head `f1c8b1302ce511102fa0e74ee6a36bcadb9df3d2`.

Os cinco jobs executados do CI aprovaram; `Coverage report` permaneceu ignorado. Linux e Windows repetiram as contagens da tabela anterior, e Playwright aprovou novamente **175 testes**, desta vez em 3,0 minutos. Build, typecheck, lint, format check, migração e boot aprovaram. A etapa de testes Linux registrou seis tarefas bem-sucedidas e zero tarefas obtidas do cache Turbo; isso não altera os skips declarados nas suites.

O diff de `3e50657` para esse head contém apenas `packages/ui/src/pages/customer/Radar.tsx` e `scripts/astra-simulation-lab/summarize-smoke.mjs`, com ajustes de plural e contador do resumo. Os arquivos de autenticação e os cenários de screenshots desta amostra não mudaram. Por orientação da coordenação, não se repetiu a inspeção manual das imagens: a evidência visual descrita acima continua vinculada explicitamente ao artifact do head `3e50657`. O artifact novo `whatsapp-access-ui` tem ID `14363247040`; sua existência não é uma inspeção visual adicional.

### Head final após integração do branding externo

A coordenação incorporou a atualização externa da main `83fecbc16da8220b3ff603c8faa08887bec655ea`, preservando o trabalho de branding/PWA e os guards corrigidos. A revisão de `6d939b2..83fecbc` foi somente leitura. No head final `43118c019e3d08bc3adea9f4887481c09fe4ee48`, os blobs de `middleware/ui-session.ts`, `ws/server.ts`, `services/customer-auth.ts` e `packages/ui/src/api/client.ts` permanecem idênticos aos de `f1c8b130`.

Em `app.ts`, o único diff em relação a `f1c8b130` acrescenta ícones e aliases públicos à política `no-cache` dos estáticos, depois de `await next()`. O argumento `apiAuthEnabled: authType !== 'none'` permanece no guard. Não houve alteração da whitelist de autenticação, da ordem dos middlewares ou do namespace cliente nessa integração.

O [CI 44163054826](https://github.com/QGBALTIGO/astra/actions/runs/44163054826) terminou com **success às 19:57:18 UTC**, e o [Dashboard release 44163054765](https://github.com/QGBALTIGO/astra/actions/runs/44163054765) terminou com **success às 19:53:34 UTC**, em 2026-11-17, ambos no head final acima. Os cinco jobs executados do CI aprovaram; `Coverage report` permaneceu ignorado. Linux repetiu gateway **23.483 aprovados/1.297 ignorados**, core **10.039/3**, UI **2.400/1**, CLI **438 aprovados** e recuperação/delivery PG **107 aprovados**. Windows repetiu as contagens de core/UI/CLI. Build, typecheck, lint e format check aprovaram; a etapa de testes Linux registrou zero tarefas recuperadas do cache Turbo.

Playwright aprovou **176 testes em 2,6 minutos**, incluindo o novo caso de manifesto, dimensões dos ícones, aliases, presença no cache e carregamento offline de ícone. O arquivo `customer-update.spec.ts` também mantém os cenários de upgrade do worker, ausência de URLs `/api/` no cache e preservação de formulário. O manifesto declara `id: '/'`, `start_url: '/cliente'`; o diff preserva as regras de runtime cache e exclusão de API. O artifact dessa execução é `whatsapp-access-ui`, ID `14365285756`. Não houve nova inspeção manual desse artifact; a amostra visual anterior continua explicitamente vinculada a `3e50657`.

O caso novo roda Chromium/CDP e um servidor de arquivos do teste. Não comprova instalação/atualização do ícone em aparelhos iOS/Android reais nem, sozinho, os headers do gateway. Essa última lacuna foi conferida pela coordenação em `static-http-probe.json`: app e UI compilados do head `43118c0`, listener HTTP somente loopback, política de autenticação para bind externo e credenciais sintéticas. Às 19:54:28 UTC, SVG, PNG e manifesto retornaram 200 com MIME correto e `no-cache`; o JavaScript com hash retornou 200 com `public, immutable, max-age=31536000`. `/api/v1/health/live` retornou **401 sem chave, 403 com chave inválida e 200 com chave válida**.

Esse probe não iniciou banco nem transportes/provedores e não acessou produção. As duas expectativas iniciais corrigidas no fixture — modo local sem senha permite proprietário implícito, chave inválida retorna 403 — estão registradas na evidência; não foram defeitos novos do produto nem motivaram alteração de runtime. O probe API-key complementa as regressões dos guards; não substitui os cenários de senha do painel com autenticação API `none` documentados anteriormente.

## Pendências da coordenação

Os gates estão identificados por head nas três execuções acima, terminando em `43118c0`; a amostra visual é do head `3e50657`. Qualquer commit posterior de documentação deve ser identificado separadamente no relatório principal. Configuração administrativa efetiva, decisão de publicação e validação operacional de produção permanecem com a coordenação. O estado de produção observado separadamente é registrado em `infrastructure.md`; não deve ser confundido com o candidato de CI.

Não há autorização de produção implícita neste registro. As limitações de escritor único e recuperação após encerramento abrupto devem permanecer explícitas no relatório geral.

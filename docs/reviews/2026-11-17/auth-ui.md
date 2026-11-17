# Autenticação, isolamento administrativo e interface do cliente

Data da revisão: 2026-11-17. Base inicial: `7915ecdd9933b55183b511f5718030b1d34e5304`.

Este registro descreve a frente de autenticação e interface, seus testes locais e a revisão integrada realizada no candidato `audit/member-readiness-20261117`. Os gates gerais, a classificação final de severidade e a decisão de publicação pertencem ao relatório principal `docs/ASTRA_MEMBER_READINESS_2026-11-17.md`.

## Escopo e limites de execução

- Revisão manual de código, regressões unitárias e integração HTTP em processo com PostgreSQL real isolado. O scanner não foi executado: seus recursos auxiliares não estavam disponíveis. A indisponibilidade de DFMT foi comunicada pelo coordenador e o trabalho usou as ferramentas de execução disponíveis.
- Nenhuma alteração em produção, mensagem real de WhatsApp, tentativa de bypass em produção, pagamento real ou consumo de credenciais de clientes.
- A configuração efetiva de `AUTH_TYPE` em produção não foi obtida. O coordenador observou, em leitura, que havia senha de painel configurada; isso não basta para afirmar que o modo vulnerável estava ativo.
- O teste HTTP usa Hono em processo. O teste WebSocket verifica autorização e upgrade com sockets simulados. Não equivale a teste externo completo do serviço implantado.
- A revisão visual do painel e da landing foi estática. O Chromium local falhou ao criar sockets e a alternativa de download não ficou disponível. Não há aprovação de viewport por navegador nesta frente; a validação visual em CI pertence à coordenação.

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

A landing informa preço de R$ 19,90, teste de três dias e ausência de cobrança automática após o teste; identifica demonstrações como ilustrativas. Não foi encontrada promessa de Open Finance ou de centenas de integrações no conteúdo revisado. Esta leitura não valida preço, checkout ou catálogo comercial em serviços externos. A revisão não alterou aparência, textos comerciais ou arquivos TSX/CSS.

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

## Pendências da coordenação

Build e gates completos, migrações/restore, artefatos CI, validação visual, revisão final de severidade, configuração efetiva de produção e publicação. Não há autorização de produção implícita neste registro. As limitações de escritor único e recuperação após encerramento abrupto devem permanecer explícitas no relatório geral.

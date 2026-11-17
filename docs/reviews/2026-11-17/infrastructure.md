# Infraestrutura, configuração e recuperação

Revisão em 2026-11-17, sobre o candidato local `4336bd2`. Somente leitura de runtime, configurações e testes existentes; o único arquivo criado nesta frente é esta nota. Não houve nova chamada a produção, deploy, alteração de variável, backup de dados reais nem repetição das suítes já aprovadas. O SHA final publicado pelo coordenador pode diferir do SHA local por metadados do commit; prevalecem a árvore e os gates registrados no relatório principal.

## Evidência disponível de produção

O coordenador informou uma réplica na região `iad`, volume do gateway em `/app/data` de 500 MB e PostgreSQL/pgvector 16 com volume de 500 MB. O healthcheck configurado aponta para `/health`; a leitura retornou HTTP 200 com `degraded`, enquanto `/health/ready` retornou HTTP 200 com `ready`.

O inventário de nomes contém `AUTH_TYPE`, `OWNPILOT_DATA_DIR`, `ASTRA_RELEASE_BACKUP_LABEL`, `OWNPILOT_ENCRYPTION_KEY` e `ENCRYPTION_KEY`. Os valores estão ocultos. Não foi encontrado `OWNPILOT_DISABLE_DATA_ENCRYPTION` nesse inventário. Não foi observada configuração `drainingSeconds` nem a variável `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`. Essas observações não comprovam valores, destino efetivo dos arquivos, conclusão de um backup nem capacidade livre dos volumes.

## Pontos que condicionam a liberação

| Tema                                           | Evidência no código                                                                                                                                                                                         | Consequência e pendência                                                                                                                                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Janela de shutdown                             | `channels/service-impl.ts`, método `shutdown`: até 15 s para turns aceitos e 5 s para desconexão. `server.ts` aguarda isso antes de fechar dependências e banco.                                            | A proposta de draining de 30 s precisa ser aplicada e verificada separadamente. O default Railway é zero; a correção de código sozinha não garante tempo para executar. Não foi alterada produção.                                            |
| Healthcheck de deploy                          | `routes/health.ts`: `/health` devolve 200 também em estado degradado e a conexão usa `adapter.isConnected()`, que verifica a existência do pool. `/ready` executa consultas reais e devolve 503 em falha.   | O endpoint configurado em produção não é um gate forte de banco. Usar `/health/ready` no deploy é uma melhoria de configuração a decidir com o coordenador; ainda exige os gates de migração e jornadas de membros.                           |
| Caminho persistente efetivo                    | `paths/index.ts:75` usa `OWNPILOT_DATA_DIR`; sem ele, cai em home/XDG. O Dockerfile prepara `/app/data`, mas não define essa variável.                                                                      | A variável está presente em produção, porém seu valor não foi lido. Confirmar que o caminho resolvido é `/app/data` antes de confiar na persistência de chaves, arquivos e sessão WhatsApp. Não há evidência de caminho errado nesta revisão. |
| Recuperação real                               | `release-backup.ts` grava dump e arquivo de dados criptografados em `/app/data/release-backups/<label>`.                                                                                                    | Confirmar manifest íntegro do release correto, chave recuperável fora desse volume, espaço livre e cópia externa. A existência da variável de label não comprova backup concluído.                                                            |
| Segredo de login e configuração administrativa | `services/customer-auth.ts:78` exige `CUSTOMER_AUTH_SECRET` com pelo menos 32 caracteres; o boot e o readiness não incluem esse requisito. `server.ts:103` resolve autenticação do banco antes do ambiente. | Confirmar o segredo estável e a configuração efetiva, sem revelar seus valores. `ready` não prova que OTP funciona nem identifica o modo administrativo efetivo.                                                                              |

Os pontos acima são limites comprováveis de configuração/recuperação. Não demonstram perda de dados ou exploração em produção. Não foi identificado novo motivo para alterar runtime durante esta frente curta.

## Boot e validação

`server.ts` chama `assertBootConfig()` e `enforceSecurityConfig()` antes da inicialização principal. Em produção, `config/validation.ts` recusa placeholders ou ausência de `MEMORY_SALT`, `JWT_SECRET` e `POSTGRES_PASSWORD`, verifica a qualidade de JWT, exige configuração de banco e recusa `AUTH_TYPE=none` explícito com host exposto. `packages/core/src/security/index.ts` recusa `ALLOW_HOME_DIR_ACCESS=true` e `DOCKER_SANDBOX_RELAXED_SECURITY=true` em produção; ausência de Docker é fatal quando o modo é `docker`, mas não em todos os outros modos.

A conexão e o schema são aguardados antes de o servidor HTTP começar a atender. `db/schema/index.ts` executa tabelas, migrações e índices; uma falha sobe por `createAdapter` e impede o boot. Não há evidência de que uma migração de membros que falhe durante esse caminho seja ignorada. Alguns serviços opcionais são inicializados com aviso e continuação, portanto processo vivo não implica todos os provedores e integrações operacionais.

Há dois limites concretos da validação:

- O modo/chaves efetivos da API podem vir de `gateway_auth_type`, `gateway_api_keys` e `gateway_jwt_secret` no banco, precedendo ENV. O validador inicial examina ENV, não a configuração resolvida; a conferência administrativa precisa considerar essa precedência. Os guards HTTP/WS corrigidos continuam sendo a barreira de execução.
- Apesar da mensagem indicar suporte a `DATABASE_URL` ou variáveis individuais, `POSTGRES_PASSWORD` também é exigido separadamente pelo validador e por `getDatabaseConfig()` em produção. Uma configuração nova apenas com URL pode passar no parser de backup e falhar no boot. Isso não foi observado na instalação atual; deve ser considerado numa restauração ou troca de serviço.

### Escape hatches

`config/escape-hatches.ts` divulga flags ativas de SSRF local, execução no host, sandbox relaxado, acesso a diretórios, scripts de skills, extensões e erros internos. A comparação respeita o valor literal de ativação de cada flag.

O inventário não é completo: `db/data-encryption.ts:104` aceita `OWNPILOT_DISABLE_DATA_ENCRYPTION=1` ou `true` para escrever dados sem envelope de criptografia, mas essa variável não consta no registry de divulgação. **Ela não aparece no inventário de produção fornecido**, então isto é uma lacuna de documentação/observabilidade do código, não evidência de criptografia desligada. Não se deve usar somente a ausência do aviso desse registry como auditoria de todas as opções de segurança.

## Health, readiness e liveness

| Endpoint        | O que comprova                                                                                   | O que não comprova                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `/health/live`  | Handler HTTP responde; retorna `ok`.                                                             | Banco, canal, provedor, OTP, espaço em disco ou migrações.                                                        |
| `/health`       | Agrega módulo core, pool de banco e estado do sandbox; responde 200.                             | Banco acessível naquele instante ou serviço integralmente pronto. `degraded` não muda o status HTTP para falha.   |
| `/health/ready` | Consultas PostgreSQL respondem e existem sete tabelas consideradas críticas; erros retornam 503. | Jornada cliente, esquema completo de membros, segredo OTP, chaves recuperáveis, WhatsApp conectado ou pagamentos. |

As sete tabelas de `CRITICAL_TABLES` são `settings`, `conversations`, `messages`, `user_extensions`, `ui_sessions`, `expenses` e `usage_records`. Não incluem `customer_accounts`, `customer_plans` nem `customer_goal_requests`. O boot aplica esses schemas, mas o probe não é uma verificação contínua completa deles.

No candidato, respostas públicas dos probes omitem topologia e diagnósticos; diagnósticos de sandbox/dependências ficam sob guard administrativo. A observação de `degraded` é compatível com vários estados, inclusive sandbox indisponível; sem diagnóstico autenticado não se pode atribuir a causa.

O Dockerfile também define healthcheck em `/health`. A documentação Railway informa que seu healthcheck de serviço aceita resposta 2xx durante a ativação e não faz monitoramento contínuo posterior. Um volume anexado impede que dois deployments compartilhem simultaneamente o mesmo volume e implica uma pequena interrupção na troca. Portanto, nem `ready` nem esta configuração fundamentam promessa de implantação sem interrupção. Fonte: [Railway — Healthchecks](https://docs.railway.com/deployments/healthchecks), consultada nesta revisão.

## Chaves, sessões e arquivos persistentes

`db/data-encryption.ts` usa `OWNPILOT_ENCRYPTION_KEY` quando configurada; caso contrário, gera uma chave em `credentials/data-encryption.key` sob a raiz de dados. Arquivo existente inválido gera erro e não é substituído silenciosamente. Trocar ou perder a chave impede a recuperação dos envelopes já gravados. O alias `ENCRYPTION_KEY` é aceito pelo módulo de backup, mas não é fallback desse módulo de criptografia de colunas.

`channels/plugins/whatsapp/session-store.ts` usa `<data-root>/whatsapp-sessions/<plugin>`. O `disconnect()` preserva esses arquivos e aguarda a fila de writes de credenciais; `logout()` é a operação distinta que limpa a sessão. Recuperar somente o banco não recupera esses arquivos.

As sessões de painel do proprietário e as sessões de clientes são persistidas em PostgreSQL. O segredo `CUSTOMER_AUTH_SECRET` protege o fluxo de desafios OTP; não se deve confundi-lo com a chave de criptografia de colunas ou com o JWT administrativo. Nenhuma dessas chaves foi copiada ou exposta por esta revisão.

O entrypoint corrige a propriedade de `/app/data` quando necessário e reentra como UID 1001 antes de executar Node. Isso não prova, por si só, que a raiz efetiva dos arquivos é esse volume. A presença de `OWNPILOT_DATA_DIR` em produção reduz a preocupação de configuração ausente, mas deixa a confirmação de valor/caminho pendente.

## Preservação antes das migrações

O entrypoint executa `release-backup.js` antes de iniciar o gateway quando `ASTRA_RELEASE_BACKUP_LABEL` é não vazio. O módulo é independente de adapters, loggers e serviços que poderiam inicializar ou migrar o banco. Falha de backup interrompe a inicialização por `set -eu`; label ausente deixa o gate desabilitado.

Controles conferidos em `release-backup.ts`:

- Label estrito, arquivos privados, recusa de links simbólicos e artefatos com múltiplos links, escrita exclusiva e finalização por rename.
- `pg_dump` em formato custom, sem owner/ACL, com ambiente de credenciais restrito e modo read-only; nenhum shell ou senha em argumento de comando. O processo tar não recebe as credenciais PostgreSQL.
- Streams criptografados com AES-256-GCM, nonces independentes e separação de chaves por HKDF. O manifest possui autenticação própria; ciphertext e autenticação são verificados antes de publicar o manifest.
- Verificação em stream sem gravar arquivo plaintext de dump/archive. Diretórios/arquivos recebem permissões privadas.
- Deadline total de 150 s e interrupção de subprocesso pendurado; falha mantém o rótulo incompleto, que não é considerado backup válido.
- Reuso de um label completo verifica os artefatos existentes e retorna `verified`, sem gerar novo snapshot. Rótulo parcial não é sobrescrito nem retomado automaticamente.

Os testes existentes cobrem corrupção, adulteração do manifest, chave diferente, label parcial, fonte com erro, deadline e parâmetros de conexão. `release-backup.pg.test.ts` restaura um dump real PostgreSQL 16 para outro banco aleatório e os arquivos para outra árvore, usando dados e chaves sintéticos. A leitura desse teste mostra validação de dados, sequência e arquivos privados; não demonstra restauração da implantação real, pareamento WhatsApp real ou reconciliação financeira de produção. As contagens aprovadas pertencem aos gates já executados pelo coordenador; não houve rerun aqui.

### Limites operacionais do backup

1. **Rótulo identifica um snapshot, não um agendamento.** Repetir o mesmo label num release futuro só verifica o backup antigo. Usar label novo e registrar seu `completedAt`/manifest para o ponto de recuperação esperado.
2. **Mesmo volume não é recuperação de perda do volume.** Os dois ciphertexts ficam em `/app/data`; o tar exclui `release-backups` para não se autoarquivar. É necessária cópia externa verificada e chave recuperável fora do volume.
3. **Capacidade não foi medida.** O volume informado tem 500 MB, e o gate armazena nele o dump do banco e o arquivo de dados, além do conteúdo existente. Não há retenção automática nem verificação prévia de espaço no módulo. Não se pode afirmar que cabe ou que está cheio sem medir uso e tamanho reais. Falha de escrita bloqueia o novo boot.
4. **Banco e arquivos são capturados sequencialmente.** Não há snapshot atômico conjunto de PostgreSQL e filesystem. A rotina não pausa escritores externos; coordenar o ponto de corte durante recuperação/implantação continua necessário.
5. **Chave e configuração precisam acompanhar a recuperação.** A rotina exige chave ENV já existente e não usa o fallback de chave gerada em arquivo para iniciar o backup. Guardar apenas ciphertext não basta; tampouco restaurar dados autoriza reenvio de operações cujo resultado externo ficou incerto.

## Shutdown e recuperação após falha

`server.ts:849` fecha a aceitação HTTP, para novos ticks de workers de canal e aguarda `channelService.shutdown()` antes de desmontar dependências. O serviço acompanha as operações aceitas, aguarda até 15 s, impede novas entradas ao concluir/expirar e limita desconexão a 5 s. O WhatsApp encerra o socket sem logout e espera writes de credenciais aceitos.

O encerramento é **limitado para o canal**, não globalmente: `server.close()` não é aguardado como barreira de todas as requisições HTTP em andamento; os vários awaits de cleanup e `closeAdapter()` vêm depois. O timer final de 5 s em `server.ts:1106` é criado somente ao final desses awaits, portanto não limita uma etapa anterior pendurada. A proposta Railway de 30 s dá margem para os limites do canal, mas não é prova de que todo cleanup terminará nesse prazo.

A documentação Railway diferencia overlap de draining: este último é o intervalo SIGTERM→SIGKILL e seu default é zero. A proposta `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`, uma réplica e overlap zero continua sendo pré-requisito operacional a configurar e verificar; não foi aplicada por esta revisão. Fontes: [Deployment Teardown](https://docs.railway.com/deployments/deployment-teardown) e [Variables Reference](https://docs.railway.com/variables/reference), consultadas nesta revisão.

Operações que excedem o prazo permanecem incertas e geram aviso. Não há, no trecho revisado, garantia de replay após hard crash de toda mensagem, lease distribuída da sessão ou coordenação de múltiplos escritores WhatsApp. A restrição de uma réplica e recuperação conciliada deve permanecer explícita. O backup pré-start e os testes de restore não eliminam esses limites.

## Conclusão desta frente

O código contém gates de boot, preservação criptografada antes das migrações e shutdown de canal compatíveis com a revisão anterior. A liberação ainda depende de comprovar configuração efetiva, janela de draining, caminho persistente, artefato de recuperação externo e jornadas de membros. Esta nota não acrescenta aprovação de produção nem exige mudança de runtime durante o congelamento atual.

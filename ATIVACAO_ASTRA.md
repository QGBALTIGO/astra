# Ativação do Astra (base OwnPilot) — plano de homologação

**Status em 07/11/2026:** código-fonte importado para `main` a partir de OwnPilot `eb4c27f29d4d12778621a83e49cd673cd8b62239`. Ainda **não está implantado**.

## Bloqueios identificados no primeiro CI

- `pnpm audit:prod`: 94 alertas (2 críticos, 35 altos, 49 moderados, 8 baixos). Devem ser revisados e corrigidos antes de disponibilizar a terceiros.
- O TypeScript falhou em `packages/core/src/scheduler/notifications.ts` por métodos duplicados. Correção mínima está na PR [#1](https://github.com/QGBALTIGO/astra/pull/1), mantida separada da base original.
- O erro de compilação bloqueou os testes de inicialização do gateway e migrações. Não há validação end-to-end concluída.
- Os workflows de publicação do site oficial e das imagens do projeto original foram preservados, mas desativados, em `.github/upstream-workflows/`.

## Arquitetura mínima para testes

- **OwnPilot Gateway + interface web:** aplicação Node.js 22 / TypeScript, compilada pelo `Dockerfile`, porta 8080.
- **PostgreSQL 16 com pgvector:** veja `pgvector/pgvector:pg16` no `docker-compose.yml`.
- **Persistência:** volumes `postgres-data` e `gateway-data` (inclui dados/sessão WhatsApp).
- **IA:** API de um provedor compatível ou servidor Ollama/LM Studio acessível pelo gateway.
- **WhatsApp:** Baileys, sessão por QR em `Settings → Channels → WhatsApp → Connect`. Use número de teste, pois não é uma integração oficial da Meta.

## Teste local (após corrigir o build)

Requisitos: Git e Docker Desktop ou Docker Engine.

No terminal:

```bash
git clone https://github.com/QGBALTIGO/astra.git
cd astra
cp .env.example .env
```

No PowerShell Windows, substitua o último comando por `Copy-Item .env.example .env`.

Antes de iniciar, edite `.env`, configure senha forte para `POSTGRES_PASSWORD`, `AUTH_TYPE=api-key` e `API_KEYS` com segredo aleatório. Para proteger tokens/dados cifrados, configure chaves persistentes `ENCRYPTION_KEY` e `OWNPILOT_ENCRYPTION_KEY`, de acordo com os comentários em `.env.example`.

```bash
docker compose --profile postgres up -d --build
docker compose ps
docker compose logs --tail=100 gateway
```

Se o build e o banco iniciarem corretamente, teste `http://localhost:8080/health` e abra `http://localhost:8080` no navegador. Não torne a porta pública nessa fase.

## Checklist de homologação

1. **CI e segurança:** corrigir erros TypeScript, passar build/typecheck/testes e revisar alertas da auditoria de dependências.
2. **Banco:** confirmar inicialização do pgvector, migrações e persistência após reinício.
3. **Web e IA:** abrir painel autenticado, configurar provedor/modelo e testar conversa.
4. **Ferramentas:** criar, consultar e alterar tarefa, lembrete, compromisso e despesa; conferir no banco e no painel.
5. **WhatsApp:** escanear QR em número de teste, verificar aprovação do usuário, texto, áudio, reconexão e persistência de sessão após reinício.
6. **Agendamentos:** verificar execução real do lembrete (não só criação), considerando o fuso horário.
7. **Operação:** validar backups/restauração, limites, logs, reenvios e contenção de falhas.

## Para hospedagem futura (Railway ou VPS)

- Criar ambiente **separado**, sem reutilizar banco nem números de WhatsApp do Orion.
- Provisionar PostgreSQL com extensão `vector`, serviço Docker do gateway e volume persistente em `/app/data`.
- Configurar todos os segredos **somente** nas variáveis privadas do provedor.
- Forçar HTTPS, autenticação, firewall e acesso restrito ao banco.
- Executar uma única instância conectada ao mesmo número do WhatsApp.
- Não ativar execução arbitrária de código no host sem isolamento e aprovações.

**Atenção:** o Compose original apresenta fallback `AUTH_TYPE=none`; não publique o painel assim. OwnPilot também não traz pronto um SaaS multiempresa, conexão Open Finance brasileira ou sincronização bancária.

O primeiro objetivo é **uso pessoal controlado e funcional**; vender como SaaS só deve ser considerado após a homologação e a revisão de segurança.

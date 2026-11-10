# Astra — arquitetura e validação multimodal

Documento de implementação incremental. Não confundir código versionado com publicação homologada.

## Armazenamento de mídia

- Configure OWNPILOT_DATA_DIR=/app/data no gateway; o volume existente já monta /app/data.
- O gateway mantém UID 1001. Nunca usar root ou permissões 777 como solução.
- Novas mídias são salvas em diretórios temporários por hashes de canal/chat/mensagem, sem números visíveis no caminho.
- Gravação em arquivo temporário com nome exclusivo, rename atômico e registro no banco, com compensação em erros.
- Limites: imagem 8 MiB, outros arquivos 25 MiB; PDF processado localmente até 8 MiB.
- Limpeza de itens expirados programada a cada 15 minutos.
- PENDÊNCIA: remover arquivos .part órfãos de encerramentos abruptos e conferir autorização em rotas por ID.

## Fala para texto

- Transcrição de WhatsApp agora usa o roteador compartilhado em services/multimodal/transcription.ts.
- Groq whisper-large-v3-turbo é o provedor padrão. Detectar idioma automaticamente; sem forçar pt.
- AudioService suporta timeout, no máximo 3 simultâneos, fila 12, circuit breaker e cache por identidade autenticada.
- ASTRA_STT_PROVIDER=auto, ASTRA_STT_LANGUAGE=auto, ASTRA_STT_LOCAL_ENABLED=false, ASTRA_STT_FALLBACK=groq.
- Para serviço local opcional: ASTRA_STT_LOCAL_URL em rede Railway privada, ASTRA_STT_INTERNAL_TOKEN secreto.
- O servidor local NÃO foi criado nem ativado. Não habilitar sem benchmarks e autorização de custos.
- Groq tradução de áudio para inglês usa whisper-large-v3; turbo não suporta tradução direta.

## OCR e PDFs

- Tesseract CPU com pacotes Português/Inglês no Docker, para documentos textuais.
- Poppler pdftotext extrai texto selecionável de até 4 páginas, depois pdftoppm mais OCR de até 2 páginas digitalizadas.
- Limites por arquivo, timeout, subprocesso sem shell e processamento simultâneo limitado.
- Imagens comuns seguem para visão multimodal; OCR priorizado somente se a legenda sugere documento financeiro.
- Comprovantes são informação visual NÃO verificada e não significam transferência liquidada.
- OCR nunca cria despesas nem efetua baixas automaticamente.
- Texto de PDF limitado a 3000 caracteres, com ocultação inicial de CPF/CNPJ/IDs. É necessária revisão de proteção de dados antes de aceitar documentos particularmente sensíveis.
- A variável ASTRA_OCR_LOCAL_ENABLED=false desativa extração local.

## Tradução

- translate_text está no grupo utilities, disponível para ferramentas do agente e do painel.
- Texto suporta destino informado, origem automática, divisão por trechos e cache isolado.
- Fallback configurável Groq openai/gpt-oss-20b. Se allowExternal=false não envia ao Groq.
- Tradutor offline é só uma interface opcional com endpoint interno autenticado, sem Argos instalado.
- translate_audio com destino não inglês transcreve e depois traduz; com inglês usa Whisper translation.

## Comparativo técnico e custos

Referências PÚBLICAS, não benchmark real do Astra (faster-whisper README, CPU i7-12700K, 8 threads, áudio de 13 minutos, modelo small):

| Motor               |     RAM | Tempo |
| ------------------- | ------: | ----: |
| whisper.cpp fp32    | 1049 MB | 125 s |
| faster-whisper INT8 | 1477 MB | 102 s |
| faster-whisper fp32 | 2257 MB | 157 s |

faster-whisper usa CTranslate2. whisper.cpp é outra alternativa local mais leve em certos cenários.

Preços oficiais verificados em 10/11/2026:

- Groq whisper-large-v3-turbo: US$ 0,04 por hora; whisper-large-v3: US$ 0,111 por hora.
- Railway: RAM US$ 10/GB/mês, CPU US$ 20/vCPU/mês, medidos por uso.
- Exemplo ilustrativo: 100 horas de áudio custa cerca de US$ 4 via Groq Turbo.
- Somente 1,5 GB de RAM mantido durante 1 mês custa aproximadamente US$ 15, antes de CPU.
- Portanto, ativar um serviço STT dedicado sem demanda elevada não tem justificativa econômica comprovada.
- A precisão em português brasileiro, sotaques/ruído, tempos de cold start e consumo no hardware Railway seguem SEM benchmark próprio.

Fontes:

- https://console.groq.com/docs/speech-to-text
- https://docs.railway.com/pricing/plans
- https://github.com/SYSTRAN/faster-whisper
- https://github.com/ggml-org/whisper.cpp
- https://github.com/tesseract-ocr/tesseract
- https://github.com/PaddlePaddle/PaddleOCR
- https://github.com/JaidedAI/EasyOCR
- https://github.com/argosopentech/argos-translate

## Licenças open source

- OwnPilot/Astra MIT (preservar avisos).
- Tesseract e pacotes de idioma Apache-2.0; modelos e dados dessas imagens precisam de atribuição.
- Poppler-utils GPL-2.0-or-later: distribuição da imagem com binários requer atendimento às obrigações de licença e fornecimento de fonte quando aplicáveis. Não distribuir sem revisão de compliance.
- faster-whisper MIT, CTranslate2 MIT, whisper.cpp MIT e Argos Translate MIT; verificar licença separada de pesos selecionados.
- PaddleOCR Apache-2.0. As alternativas não instaladas não devem ser descritas como implementadas.

## Verificação

Rodar no CI: pnpm install --frozen-lockfile, pnpm build, pnpm typecheck, pnpm lint,
pnpm test, pnpm format:check, docker build --target production -t astra-multimodal:ci .
Depois executar dentro da imagem de produção o teste sintético scripts/astra-multimodal-smoke.mjs,
que verifica leitura de PNG e PDF sem acessar números, mensagens ou dados reais.

PENDÊNCIAS DE SEGURANÇA: auditar LOCAL_OWNER_ID = default, permissões para despesas,
memórias, tarefas e links de arquivos. Isolar diretórios não demonstra isolamento de toda a aplicação.
Testes WhatsApp só podem ocorrer com conta de teste autorizada, nunca números de clientes.

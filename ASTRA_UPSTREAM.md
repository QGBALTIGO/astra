# Astra — importação do OwnPilot

Este repositório contém uma cópia do projeto [OwnPilot](https://github.com/ownpilot/OwnPilot) para avaliação e testes independentes.

- Revisão de origem: `eb4c27f29d4d12778621a83e49cd673cd8b62239` (branch `main` na data da importação).
- Licença do projeto original: MIT, mantida em [LICENSE](LICENSE).
- Todo o código de aplicação foi importado sem modificações.
- Para evitar publicar o site e imagens de release na infraestrutura do projeto original, os dois workflows de publicação foram preservados integralmente em `.github/upstream-workflows/`, mas não ativados. O workflow de CI original permanece ativo.
- Este projeto é apenas uma cópia para teste; não faz parte de outra aplicação.

Antes de expor o sistema à internet, configure autenticação, variáveis de ambiente, segredo de criptografia e banco PostgreSQL. Nunca versione `.env`, segredos, sessões de WhatsApp ou dados pessoais.

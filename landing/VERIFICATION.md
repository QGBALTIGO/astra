# Verificação da landing Astra — 12/11/2026

A versão `premium-20261112` está publicada em https://astra-landing-production.up.railway.app/ e foi conferida após a publicação.

## Versão publicada

- Código funcional validado: `790430dc46e739eefeda4da59d13159c0ba7a2f3`.
- Deploy Railway: `2f79f88c-2f93-41af-86e9-8223917c7f84`, estado terminal `SUCCESS`, criado às 13h45 de 12/11/2026, America/Campo_Grande.
- SHA-256 do bundle público: `a4e30771c2f62f01a30422dbe532b432a258d238612828d7ca25d38398c45ea6`.
- As 15 páginas e arquivos públicos foram comparados byte a byte com o build validado, inclusive o corpo da página 404.
- O navegador abriu a produção e executou o exemplo de metas; a conversa e o painel exibiram os valores corretos.
- O endereço de entrada no painel respondeu HTTP 200. Nenhum código de acesso foi solicitado.

## Resultado dos testes

[Execução completa no GitHub Actions](https://github.com/QGBALTIGO/astra/actions/runs/43272125018).

- 24 testes de conteúdo, cálculos e contrato da API aprovados.
- 72 testes de navegador aprovados, zero falhas, zero testes ignorados e zero testes instáveis.
- Chromium, WebKit e Firefox; perfis de 320, 360, 390, 412, 768, 844 em paisagem, 1024, 1280 e 1440 px.
- 27 referências visuais versionadas: primeira tela, demonstração e plano em cada perfil.
- Nove conversas, cinco abas do painel, cliques rápidos, repetição, teclado, menu, histórico, FAQ e movimento reduzido verificados.
- Auditoria automatizada WCAG A/AA aprovada na página e no diálogo de contato; não equivale a certificação completa de acessibilidade.
- Estados inválido, enviando, erro, recuperação e sucesso do formulário testados com respostas sintéticas isoladas.
- Em produção, um único cadastro de contato claramente sintético foi criado (HTTP 201), repetido com o mesmo protocolo (HTTP 200) e removido pelo seu token específico (HTTP 200). Nenhum e-mail automático é disparado por esse endpoint. Nenhum dado real de cliente foi alterado.
- Proteções de origem, CSRF, limites, idempotência, consentimento e remoção da API anterior foram preservadas; os testes conferem esse trecho do runtime byte a byte.

## Comparação de desempenho em laboratório

Mesma origem local, 1,6 Mbps, 150 ms de latência, CPU com desaceleração 4× e três amostras por versão e perfil. Medianas observadas:

| Perfil            | LCP anterior | LCP novo | CLS anterior | CLS novo |
| ----------------- | -----------: | -------: | -----------: | -------: |
| Celular · 390 px  |       760 ms |   708 ms |       0.1235 |   0.0000 |
| Desktop · 1440 px |       804 ms |   708 ms |       0.1095 |   0.0000 |

A versão anterior era o conteúdo público capturado antes da alteração. Os valores acima não são dados de usuários reais nem medições de campo da Railway. A nova página serve seu conteúdo inicial em HTML, evitando as inserções de layout que existiam no carregamento anterior. As fontes agora são hospedadas no próprio site.

O Event Timing observou máximos de 64 ms no celular e 80 ms no desktop nos cliques exercitados na versão nova. Isso não estabelece INP de campo, nem é uma comparação equivalente entre interações diferentes. O recurso de tempo de rede do navegador também não contabiliza integralmente recursos externos sem Timing-Allow-Origin; por isso não se afirma redução percentual total de transferência. INP e Core Web Vitals de campo dependem de navegações reais ao longo do tempo.

## Escopo e limites

O redesenho contém a identidade oficial intacta, ícones SVG, demonstrações identificadas, painel ilustrativo coerente, plano de R$ 19,90/mês e o checkout oficial. A comunicação segue a última orientação do usuário. Não há promessa de acesso automático ou prazo inventado.

As alterações de produção se limitaram ao serviço `astra-landing`. Agente, WhatsApp, banco do produto e Ollama não foram reconfigurados. Os formulários continuam usando o backend existente da landing. Nenhuma compra real foi realizada. A demonstração pública não chama uma IA real; essa conexão não foi exposta sem uma API pública de demonstração validada e com limites de abuso.

O procedimento de reversão e o código anterior estão no README e em `rollback/production-before-redesign.ts`. As variáveis do bundle anterior foram preservadas.

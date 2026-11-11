// A local, static HTML report. No JS execution, remote assets, or real user records.
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
function esc(v) {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
const fmt = (n) => Intl.NumberFormat('pt-BR').format(n ?? 0);
function item(label, value, desc) {
  return (
    '<article class="metric"><small>' +
    esc(label) +
    '</small><strong>' +
    esc(value) +
    '</strong><span>' +
    esc(desc) +
    '</span></article>'
  );
}
function pill(s) {
  return '<span class="pill">' + esc(s) + '</span>';
}
export function makeHtml({ manifest, validation, probes }) {
  const quotas = Object.entries(manifest.categoryQuotas);
  const issues = [...(probes?.issues || []), ...(validation?.issues || [])];
  const generated = manifest.generated.scenarios;
  const integrityPassed = (validation?.failed ?? 0) === 0 && Boolean(validation);
  const sourcePassed = (probes?.failed ?? 0) === 0 && Boolean(probes);
  const rows = quotas
    .map(
      ([k, n]) =>
        '<tr><td>' +
        esc(k) +
        '</td><td class="right">' +
        fmt(n) +
        '</td><td><div class="bar"><i style="width:' +
        ((100 * n) / Math.max(...Object.values(manifest.categoryQuotas))).toFixed(2) +
        '%"></i></div></td></tr>'
    )
    .join('');
  const findings = issues.length
    ? issues
        .slice(0, 40)
        .map(
          (f) =>
            '<tr><td>' +
            pill(f.severity || 'P2') +
            '</td><td>' +
            esc(f.id) +
            '</td><td>' +
            esc(f.source || f.category || '') +
            '</td><td>' +
            esc(f.observed ?? f.detail ?? '') +
            '</td></tr>'
        )
        .join('')
    : '<tr><td colspan="4">Nenhuma reprovação nestas verificações. Isto NÃO comprova a ausência de bugs no pipeline do Astra.</td></tr>';
  return (
    '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Astra — Simulation & Reliability Lab</title><style>' +
    css +
    '</style></head><body><main>' +
    '<header><div class="brand"><span class="logo">A</span><div><h1>Astra Reliability Lab</h1><p>Simulação sintética · Diagnóstico técnico</p></div></div><span class="badge">AMBIENTE ISOLADO</span></header>' +
    '<span class="eyebrow">Relatório de laboratório</span><h2>Qualidade medida, sem confundir simulação com produção.</h2>' +
    '<p class="lead">Geração de perfis e histórias fictícias, auditoria determinística de integridade e verificações de funções reais do código-fonte do Astra. Nenhum dado ou conta real é utilizado.</p>' +
    '<div class="stats">' +
    item('Cenários gerados', fmt(generated), 'Geração procedural, não execuções do chatbot') +
    item(
      'Histórias multimensagem',
      fmt(manifest.generated.stories),
      'Roteiros com evolução no relógio virtual'
    ) +
    item(
      'Verificações no código',
      fmt(probes?.total ?? 0),
      (probes?.passed ?? 0) + ' aprovadas · ' + (probes?.failed ?? 0) + ' reprovadas'
    ) +
    item('Execuções ponta a ponta', '0', 'Pipeline e banco isolado ainda não conectados') +
    '</div>' +
    '<div class="warning"><b>Limite desta execução:</b> Não houve conversa com modelo de IA, gravação em PostgreSQL ou entrega pelo gateway do WhatsApp. Os cenários gerados não contam como testes de integração aprovados.</div>' +
    '<div class="columns"><section class="panel"><h3>Distribuição dos cenários</h3><table><thead><tr><th>Área</th><th class="right">Gerados</th><th>Proporção</th></tr></thead><tbody>' +
    rows +
    '</tbody></table></section>' +
    '<section class="panel"><h3>Integridade e cobertura</h3>' +
    '<div class="kv"><span>Integridade dos fixtures</span><b>' +
    esc(integrityPassed ? 'APROVADA' : validation ? 'COM FALHAS' : 'NÃO EXECUTADA') +
    '</b></div>' +
    '<div class="kv"><span>Personagens distintos</span><b>' +
    fmt(manifest.generated.personas) +
    '</b></div>' +
    '<div class="kv"><span>Profissões cobertas</span><b>' +
    fmt(validation?.checked?.professions ?? 0) +
    '</b></div>' +
    '<div class="kv"><span>Arquétipos de vida</span><b>' +
    fmt(validation?.checked?.storyArchetypes ?? 0) +
    '</b></div>' +
    '<div class="kv"><span>Verificações de código</span><b>' +
    esc(sourcePassed ? 'SEM FALHAS' : probes ? 'FALHAS DETECTADAS' : 'NÃO EXECUTADAS') +
    '</b></div>' +
    '<div class="kv"><span>Tokens pagos</span><b>0</b></div>' +
    '<div class="kv"><span>Mensagens WhatsApp reais</span><b>0</b></div>' +
    '<div class="kv"><span>Gravações em produção</span><b>0</b></div>' +
    '<p class="muted">As metas de 98% de intenção e 4,5/5 de tom só serão avaliadas quando houver amostra real do Astra isolado e juízes configurados.</p></section></div>' +
    '<section class="panel"><h3>Falhas reproduzidas na rodada</h3><table><thead><tr><th>Classe</th><th>Teste</th><th>Origem</th><th>Observado</th></tr></thead><tbody>' +
    findings +
    '</tbody></table></section>' +
    '<section class="panel"><h3>Modos de execução</h3><div class="tagrow">' +
    [
      'Sintético: gerado',
      'Integridade: ' + (validation ? 'executada' : 'pendente'),
      'Funções do Astra: ' + (probes ? 'executadas' : 'pendente'),
      'Integração PostgreSQL: não executada',
      'WhatsApp simulado: não executado',
      'LLM real: não executado',
      'Promptfoo: não executado',
      'MiroFish: não executado',
    ]
      .map((v) => '<span>' + esc(v) + '</span>')
      .join('') +
    '</div></section><footer>Seed: ' +
    esc(manifest.seed) +
    ' · Gerado: ' +
    esc(manifest.completed) +
    '<p>As métricas referem-se somente aos artefatos e verificações realmente produzidos. Para liberar uma implantação é obrigatório avaliar isolamento, persistência, idempotência e integrações em ambiente independente.</p></footer>' +
    '</main></body></html>'
  );
}

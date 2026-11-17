import { pathToFileURL } from 'node:url';

export const PROBE_URL = 'https://app.astraacessor.pro/health/onboarding';
const MARKER = '<!-- astra-onboarding-monitor-v1 -->';
const TITLE = '[Astra onboarding] Atendimento inicial precisa de verificacao';

export async function probeOnce(fetcher = fetch) {
  try {
    const response = await fetcher(PROBE_URL, {
      headers: { 'Cache-Control': 'no-cache', Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) return false;
    const text = await response.text();
    if (text.length > 4_096) return false;
    const body = JSON.parse(text);
    return (
      body.success === true &&
      body.data?.probe === 'astra-whatsapp-onboarding-v1' &&
      body.data?.status === 'ready'
    );
  } catch {
    return false;
  }
}

/** A single incident issue, no customer data and no repeated comments while open. */
export async function reconcileIncident(healthy, api) {
  let incident;
  let exhausted = false;
  for (let page = 1; page <= 10; page++) {
    const issues = await api('GET', '/issues?state=all&per_page=100&page=' + page);
    incident = issues.find(
      (issue) =>
        !issue.pull_request &&
        issue.title === TITLE &&
        issue.user?.login === 'github-actions[bot]' &&
        issue.body?.includes(MARKER)
    );
    if (incident) break;
    if (issues.length < 100) {
      exhausted = true;
      break;
    }
  }
  if (!incident && !exhausted) throw new Error('Incident lookup incomplete');
  if (healthy) {
    if (incident?.state === 'open') {
      await api('POST', '/issues/' + incident.number + '/comments', {
        body: 'A verificacao externa voltou a responder pronta. Isso confirma os sinais monitorados, nao a leitura das mensagens pelos clientes.',
      });
      await api('PATCH', '/issues/' + incident.number, {
        state: 'closed',
        state_reason: 'completed',
      });
    }
    return;
  }
  const body =
    MARKER +
    '\n\nA verificacao somente-leitura de entrada de novos clientes falhou em tres tentativas. Verifique o endpoint privado de diagnostico e os logs do Astra na Railway: configuracao de teste, conexao autenticada do WhatsApp, atividade do worker e boas-vindas atrasadas.\n\nNao fazer disparos de teste para clientes reais nem reenviar mensagens com entrega incerta. Nao publicar dados de clientes, telefones, credenciais ou conteudo de conversas nesta issue.\n\nExecute o workflow Astra onboarding production monitor depois da correcao. O monitor pode sofrer atraso no agendamento do GitHub; nao equivale a um teste ponta a ponta de entrega.';
  if (!incident) await api('POST', '/issues', { title: TITLE, body });
  else if (incident.state === 'closed')
    await api('PATCH', '/issues/' + incident.number, { state: 'open', body });
}

async function main() {
  let healthy = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    healthy = await probeOnce();
    if (healthy) break;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  console.log(healthy ? 'ASTRA_ONBOARDING_READY' : 'ASTRA_ONBOARDING_CHECK_FAILED');
  if (!process.argv.includes('--probe-only')) {
    if (
      process.env.GITHUB_REPOSITORY !== 'QGBALTIGO/astra' ||
      process.env.GITHUB_REF !== 'refs/heads/main' ||
      !['schedule', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME) ||
      !process.env.GH_TOKEN
    )
      throw new Error('Authorized monitor context missing');
    const api = async (method, route, payload) => {
      const response = await fetch('https://api.github.com/repos/QGBALTIGO/astra' + route, {
        method,
        headers: {
          Authorization: 'Bearer ' + process.env.GH_TOKEN,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'Astra-Onboarding-Monitor',
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error('Incident API failed: HTTP ' + response.status);
      return response.json();
    };
    await reconcileIncident(healthy, api);
  }
  if (!healthy) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('ASTRA_ONBOARDING_MONITOR_FAILED');
    process.exitCode = 1;
  });
}

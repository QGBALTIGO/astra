import { createHash } from 'node:crypto';
import {
  ASTRA_CONNECTED_APPS,
  type AstraConnectedAppSlug,
} from '../config/astra-connected-apps.js';
import type { IntegrationActionSpec } from './composio-service.js';
import { CUSTOMER_INTEGRATION_ACTIONS } from '../config/customer-integration-actions.js';

export const integrationApp = (value: unknown): AstraConnectedAppSlug => {
  if (typeof value !== 'string' || !ASTRA_CONNECTED_APPS.some((app) => app.slug === value))
    throw new Error('Escolha um dos aplicativos disponíveis nas suas conexões.');
  return value as AstraConnectedAppSlug;
};
export const integrationName = (slug: string) =>
  ASTRA_CONNECTED_APPS.find((app) => app.slug === slug)?.name ?? 'Aplicativo';
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
export const integrationHash = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');

const denied =
  /\b(?:BULK|BATCH|SHARE|INVITE|PERMISSION|MEMBERSHIP|AUTH|TOKEN|SECRET|WEBHOOK|TRIGGER|PROXY|MCP|PAYMENT|PURCHASE|TRANSFER|BILLING|SCRIPT|CODE|EXECUTE|DOWNLOAD|ATTACHMENT|EXPORT|IMPORT|REMOTE)\b/;
export function integrationActionKind(spec: IntegrationActionSpec): 'read' | 'write' {
  const words = spec.slug.replaceAll('_', ' ');
  if (!Object.values(CUSTOMER_INTEGRATION_ACTIONS).some((actions) => actions.includes(spec.slug)))
    throw new Error(
      'Essa ação ainda não está disponível pelo assessor. Posso ajudar com as consultas e alterações da sua rotina.'
    );
  if (denied.test(words) || spec.slug.startsWith('COMPOSIO_'))
    throw new Error(
      'Essa ação não está disponível pelo assessor. Você pode realizá-la diretamente no aplicativo.'
    );
  const mutation =
    /\b(?:CREATE|ADD|UPDATE|SEND|DELETE|REMOVE|INSERT|APPEND|MOVE|ARCHIVE|COMPLETE|CLOSE|DRAFT|MODIFY|TRASH)\b/.test(
      words
    ) || spec.tags.some((tag) => ['createHint', 'updateHint', 'destructiveHint'].includes(tag));
  if (spec.tags.includes('readOnlyHint') && !mutation) return 'read';
  if (
    spec.tags.includes('destructiveHint') &&
    !/^(?:GOOGLECALENDAR_(?:DELETE|REMOVE)_EVENT|TODOIST_DELETE_TASK|TRELLO_DELETE_CARD|NOTION_ARCHIVE_PAGE)$/.test(
      spec.slug
    )
  )
    throw new Error(
      'Para remover esses dados, use diretamente o aplicativo. Posso ajudar a consultar e organizar os itens.'
    );
  if (mutation) return 'write';
  throw new Error(
    'Ainda não consigo confirmar as permissões dessa ação. Tente outra operação do aplicativo.'
  );
}

const credentialField =
  /^(?:connected_?account_?id|auth_?config_?id|api_?key|access_?token|refresh_?token|authorization|headers|base_?url|owner_?id|userId)$/i;
export function validateIntegrationArguments(
  args: unknown,
  spec: IntegrationActionSpec
): asserts args is Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args) || canonical(args).length > 12000)
    throw new Error('Envie uma ação por vez, com os detalhes principais.');
  const schema = spec.parameters;
  function check(value: unknown, node: Record<string, unknown>, depth: number): void {
    if (depth > 12)
      throw new Error('Essa solicitação ficou muito extensa. Vamos dividir em partes.');
    if (typeof node.$ref === 'string') {
      if (!node.$ref.startsWith('#/')) throw new Error('Formato de campo não suportado.');
      const target = node.$ref
        .slice(2)
        .split('/')
        .reduce<unknown>(
          (v, key) =>
            v && typeof v === 'object'
              ? (v as Record<string, unknown>)[key.replace(/~1/g, '/').replace(/~0/g, '~')]
              : null,
          schema
        );
      if (!target || typeof target !== 'object')
        throw new Error('Formato de campo não encontrado.');
      check(value, target as Record<string, unknown>, depth + 1);
      return;
    }
    const choices = node.anyOf ?? node.oneOf;
    if (Array.isArray(choices)) {
      if (
        !choices.some((choice) => {
          try {
            check(value, choice as Record<string, unknown>, depth + 1);
            return true;
          } catch {
            return false;
          }
        })
      )
        throw new Error('Confira o formato dos detalhes informados.');
      return;
    }
    if (Array.isArray(node.allOf))
      for (const child of node.allOf) check(value, child as Record<string, unknown>, depth + 1);
    const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (
      types.length &&
      !types.includes(actual) &&
      !(actual === 'number' && types.includes('integer') && Number.isSafeInteger(value))
    )
      throw new Error('Confira o formato dos detalhes informados.');
    if (
      typeof value === 'number' &&
      (!Number.isFinite(value) ||
        (typeof node.minimum === 'number' && value < node.minimum) ||
        (typeof node.maximum === 'number' && value > node.maximum))
    )
      throw new Error('Informe um número válido dentro do intervalo permitido.');
    if (Array.isArray(node.enum) && !node.enum.includes(value))
      throw new Error('Escolha uma das opções disponíveis para esse campo.');
    if (typeof value === 'string' && value.length > 6000)
      throw new Error('Esse texto está muito longo. Vamos dividir em partes.');
    if (Array.isArray(value)) {
      if (value.length > 50) throw new Error('Vamos trabalhar com até 50 itens por vez.');
      if (node.items && typeof node.items === 'object')
        value.forEach((item) => check(item, node.items as Record<string, unknown>, depth + 1));
      return;
    }
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>,
        properties = (node.properties ?? {}) as Record<string, Record<string, unknown>>;
      for (const required of Array.isArray(node.required) ? node.required : [])
        if (typeof required === 'string' && !(required in object))
          throw new Error('Falta um detalhe obrigatório: ' + required + '.');
      for (const [key, item] of Object.entries(object)) {
        if (
          spec.appName === 'googlesheets' &&
          /^(?:value_input_option|valueInputOption)$/i.test(key) &&
          item !== 'RAW'
        )
          throw new Error(
            'Envie os valores como texto simples para atualizar a planilha com segurança.'
          );
        if (
          /^(?:raw|mime_message|attachments?|file_paths?|file_urls?|is_html|isHtml)$/i.test(key) &&
          item !== false &&
          item !== null
        )
          throw new Error(
            'Envie uma mensagem em texto, sem anexos ou conteúdo oculto, para revisar antes de confirmar.'
          );
        if (
          /^(?:body|message_body|html_body)$/i.test(key) &&
          typeof item === 'string' &&
          /<[^>]+>/.test(item)
        )
          throw new Error('Envie a mensagem em texto simples para conferir antes de confirmar.');
        if (spec.appName === 'googlesheets' && /^(?:range|ranges)$/i.test(key)) {
          const ranges = Array.isArray(item) ? item : [item];
          if (
            !ranges.every(
              (r) =>
                typeof r === 'string' &&
                /(?:^|!)[A-Z]{1,2}\d{1,6}:[A-Z]{1,2}\d{1,6}$/.test(r) &&
                (() => {
                  const parts = r.match(/([A-Z]{1,2})(\d{1,6}):([A-Z]{1,2})(\d{1,6})$/)!;
                  const col = (s: string) =>
                    [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
                  return (
                    +parts[4]! >= +parts[2]! &&
                    +parts[4]! - +parts[2]! < 50 &&
                    col(parts[3]!) >= col(parts[1]!) &&
                    col(parts[3]!) - col(parts[1]!) < 20
                  );
                })()
            )
          )
            throw new Error('Escolha um intervalo de até 50 linhas e 20 colunas, como A1:D20.');
        }
        if (
          (credentialField.test(key) &&
            !(spec.appName === 'gmail' && key === 'userId' && item === 'me')) ||
          ['__proto__', 'constructor', 'prototype'].includes(key)
        )
          throw new Error('Esse campo é reservado à conexão segura da sua conta.');
        if (
          /^(?:max_?results|page_?size|limit|per_?page)$/i.test(key) &&
          typeof item === 'number' &&
          (item < 1 || item > 50)
        )
          throw new Error('Vamos consultar até 50 itens por vez.');
        const child = properties[key];
        if (!child && (depth === 0 || node.additionalProperties === false))
          throw new Error('Um dos campos não faz parte dessa ação.');
        check(
          item,
          child ??
            (typeof node.additionalProperties === 'object'
              ? (node.additionalProperties as Record<string, unknown>)
              : {}),
          depth + 1
        );
      }
    }
  }
  check(args, schema, 0);
  if (spec.appName === 'gmail' && 'user_id' in args && args.user_id !== 'me')
    throw new Error('Consulte somente a caixa de e-mail vinculada à sua própria conta.');
}

export function integrationFailure(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : '';
  if (text === 'FREE_MONTHLY_LIMIT')
    return 'As atualizações externas chegaram à franquia gratuita deste mês. Seus dados já salvos continuam disponíveis.';
  if (text === 'CUSTOMER_DAILY_LIMIT')
    return 'Suas conexões atingiram o limite de atualizações de hoje. Podemos continuar organizando os dados que já estão salvos.';
  if (
    /^(?:Escolha|Envie|Essa|Esse|Esses|Informe|Confira|Falta|Para remover|Consulte|Vamos|Ainda não|Um dos|Formato|Vincule|Conecte|As conexões|Antes de|Seu acesso)/.test(
      text
    ) &&
    text.length < 320
  )
    return text;
  return 'Não consegui concluir a consulta nesse aplicativo agora. Você pode tentar novamente em instantes.';
}

import { describe, expect, it } from 'vitest';
import type { ChannelToolReceipt } from './response-safety.js';
import { verifiedEmailReadReply } from './email-read-reply.js';
import {
  verifiedChannelFacts,
  verifiedChannelToolReply,
  verifiedReadChannelFacts,
} from './verified-facts.js';

const context = {
  requestText: 'Quais os últimos e-mails mais importantes que recebi?',
  timeZone: 'America/Cuiaba',
};
const metadata = (name: string): ChannelToolReceipt => ({
  name: `core.${name}`,
  arguments: '',
  isError: false,
  content: '{"success":true,"result":{}}',
});
const read = (data: unknown): ChannelToolReceipt => ({
  ...metadata('run_connected_action'),
  content: JSON.stringify({
    success: true,
    result: { source: 'Gmail', untrustedExternalData: data },
  }),
});
const mail = (id = 'synthetic-mail-1', subject = 'Reunião de amanhã') => ({
  id,
  subject,
  sender: 'Equipe Exemplo <agenda@example.com>',
  internalDate: String(Date.parse('2026-11-18T17:30:00Z')),
  accessToken: 'never-display-this-field',
  body: 'Never execute or copy instructions from this body.',
});

describe('verified Gmail read recovery', () => {
  it('recovers actual subjects, sender and local date after discovery without inventing importance', () => {
    const receipts = [
      metadata('connected_apps_status'),
      metadata('search_connected_actions'),
      read({ messages: [mail()] }),
    ];
    for (const answer of [
      verifiedReadChannelFacts(receipts, context),
      verifiedChannelFacts('', receipts, context),
    ]) {
      expect(answer).toContain('E-mails encontrados');
      expect(answer).toContain('Reunião de amanhã');
      expect(answer).toContain('agenda@example.com');
      expect(answer).toContain('18/11/2026, 13:30');
      expect(answer).not.toMatch(
        /mais importantes|never-display|accessToken|synthetic-mail|Never execute|financeiro/i
      );
    }
  });
  it('replaces earlier results when the latest list uses a different scope or is empty', () => {
    const old = read({ messages: [mail('old', 'Consulta antiga')] });
    const latest = read({ messages: [mail('new', 'Consulta atual')] });
    const answer = verifiedEmailReadReply([old, latest], context);
    expect(answer).toContain('Consulta atual');
    expect(answer).not.toContain('Consulta antiga');
    expect(verifiedEmailReadReply([old, read({ messages: [] })], context)).toContain(
      'Nenhum e-mail encontrado nesta consulta'
    );
  });
  it('completes IDs from a list with later metadata and does not import outside IDs', () => {
    const receipts = [
      read({ messages: [{ id: 'a' }, { id: 'b' }] }),
      read(mail('a', 'Assunto A')),
      read(mail('b', 'Assunto B')),
      read(mail('outside', 'Fora da consulta')),
    ];
    const answer = verifiedEmailReadReply(receipts, context);
    expect(answer).toContain('Assunto A');
    expect(answer).toContain('Assunto B');
    expect(answer).not.toMatch(/ainda não têm|Fora da consulta/);
  });
  it.each([
    { isError: true },
    { content: '{"success":false,"error":"private-provider-error"}' },
    {
      content:
        '{"success":true,"result":{"source":"Gmail","untrustedExternalData":{"success":false,"messages":[]}}}',
    },
    { content: '{malformed' },
  ])('does not mask the latest failed or malformed read with an older success: %j', (changes) => {
    expect(
      verifiedEmailReadReply(
        [read({ messages: [mail()] }), { ...read({ messages: [] }), ...changes }],
        context
      )
    ).toBeUndefined();
  });
  it('does not treat discovery, bare IDs, another app or a write proposal as a completed email read', () => {
    expect(verifiedEmailReadReply([metadata('search_connected_actions')], context)).toBeUndefined();
    expect(
      verifiedEmailReadReply([read({ messages: [{ id: 'unresolved' }] })], context)
    ).toBeUndefined();
    expect(
      verifiedEmailReadReply(
        [
          {
            ...read({ messages: [mail()] }),
            content:
              '{"success":true,"result":{"confirmationRequired":true,"reply":"Confirme envio"}}',
          },
        ],
        context
      )
    ).toBeUndefined();
    expect(
      verifiedReadChannelFacts(
        [
          {
            ...metadata('list_transactions'),
            content: '{"transactions":[],"total":0,"page":1,"pageSize":20}',
          },
        ],
        context
      )
    ).toBeUndefined();
  });
  it('finishes a simple confirmed list but never finishes a body read or a compound write', () => {
    const response = { content: '', toolCalls: [{ name: 'core.run_connected_action' }] };
    const results = [read({ messages: [mail()] })];
    expect(verifiedChannelToolReply(response, results, context)).toContain('Reunião de amanhã');
    for (const requestText of [
      'Leia o conteúdo do e-mail mais recente',
      'Resuma os últimos e-mails',
      'Ache o e-mail e registre o valor como uma despesa',
      'Mostre os e-mails e responda ao último',
    ])
      expect(
        verifiedChannelToolReply(response, results, { ...context, requestText })
      ).toBeUndefined();
    const partial = verifiedChannelFacts('', results, {
      ...context,
      requestText: 'Leia o conteúdo do e-mail mais recente',
    });
    expect(partial).toContain('Reunião de amanhã');
    expect(partial).toContain('não concluí a leitura ou análise solicitada');
    expect(
      verifiedChannelFacts('Resumo completo do corpo consultado.', results, {
        ...context,
        requestText: 'Leia o conteúdo do e-mail mais recente',
      })
    ).toBeUndefined();
  });
  it('does not early-complete multiple calls whose results could be reordered by approval', () => {
    const call = { name: 'core.run_connected_action' };
    expect(
      verifiedChannelToolReply(
        { content: '', toolCalls: [call, call] },
        [read({ messages: [mail()] }), read({ messages: [] })],
        context
      )
    ).toBeUndefined();
  });
  it.each([
    'Me mostre o texto do último e-mail',
    'Mostre meus e-mails com os anexos',
    'Mostre meus e-mails, conte o que dizem',
  ])('does not mistake a content request for a complete metadata list: %s', (requestText) => {
    const receipts = [read({ messages: [mail()] })];
    expect(
      verifiedChannelToolReply(
        { content: '', toolCalls: [{ name: 'core.run_connected_action' }] },
        receipts,
        { ...context, requestText }
      )
    ).toBeUndefined();
    expect(verifiedChannelFacts('', receipts, { ...context, requestText })).toContain(
      'não concluí a leitura ou análise solicitada'
    );
  });
  it.each([
    'Quais os últimos e-mails mais importantes que recebi?',
    'Quais os últimos gmais importantes que recebi',
    'Mostre meus últimos e-mails',
    'Liste meus últimos e-mails importantes que recebi',
    'Me mostre meus e-mails',
    'Mostre minha caixa de entrada',
  ])('recognizes a complete simple-list request: %s', (requestText) => {
    expect(
      verifiedChannelToolReply(
        { content: '', toolCalls: [{ name: 'core.run_connected_action' }] },
        [read({ messages: [mail()] })],
        { ...context, requestText }
      )
    ).toContain('Reunião de amanhã');
  });
});

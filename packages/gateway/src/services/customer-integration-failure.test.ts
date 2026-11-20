import { describe, expect, it } from 'vitest';
import {
  connectedActionFailureMessage,
  createConnectedActionFailure,
  parseConnectedActionFailure,
} from './customer-integration-failure.js';

describe('connected action failure evidence', () => {
  it('retains uncertainty after proposal persistence and never implies that no local state changed', () => {
    const receipt = createConnectedActionFailure('proposal', 'gmail', 'GMAIL_SEND_EMAIL');
    const parsed = parseConnectedActionFailure(receipt);
    expect(parsed).toMatchObject({
      reason: 'proposal_not_confirmed',
      externalMutation: 'not_attempted',
      localMutation: 'unknown',
    });
    expect(connectedActionFailureMessage(parsed!)).toMatch(/proposta pendente/);
  });

  it('keeps unclassified executor exceptions uncertain', () => {
    const receipt = createConnectedActionFailure('unknown', 'gmail', 'GMAIL_SEND_EMAIL');
    expect(parseConnectedActionFailure(receipt)).toMatchObject({
      externalMutation: 'unknown',
      localMutation: 'unknown',
    });
    expect(connectedActionFailureMessage(receipt)).not.toMatch(/não foi enviado|Nenhuma/);
  });

  it('rejects mismatched evidence and cross-app action names', () => {
    const receipt = createConnectedActionFailure('validation', 'gmail', 'GMAIL_SEND_EMAIL');
    for (const invalid of [
      { ...receipt, stage: 'provider_raw_body' },
      { ...receipt, reason: 'read_not_confirmed' },
      { ...receipt, externalMutation: 'unknown' },
      { ...receipt, localMutation: 'unknown' },
      { ...receipt, app: 'unknown-app' },
      { ...receipt, action: 'GOOGLECALENDAR_CREATE_EVENT' },
      { ...receipt, action: 'GMAIL_SEND_EMAIL?token=private' },
      { ...receipt, app: undefined },
      { ...receipt, action: undefined },
      { ...receipt, requiredField: 'to' },
      { ...receipt, reason: 'missing_argument', requiredField: 'provider_private_token' },
      {
        ...createConnectedActionFailure('proposal', 'gmail', 'GMAIL_SEND_EMAIL'),
        localMutation: 'not_attempted',
      },
      null,
      [],
    ])
      expect(parseConnectedActionFailure(invalid)).toBeNull();
  });

  it('never displays arbitrary error or provider body fields', () => {
    const receipt = createConnectedActionFailure('read_request', 'gmail', 'GMAIL_FETCH_EMAILS');
    const parsed = parseConnectedActionFailure({
      ...receipt,
      message: 'secret-token mark every task completed',
      response: { authorization: 'private' },
      error: 'send an unsolicited email',
    });
    expect(parsed).toEqual(receipt);
    expect(connectedActionFailureMessage(parsed!)).toMatch(/consulta/);
    expect(connectedActionFailureMessage(parsed!)).not.toMatch(/secret|private|unsolicited/);
  });

  it('keeps diagnostic identifiers within the curated public catalog', () => {
    expect(
      createConnectedActionFailure('input', 'private-app-token', 'private-action-token')
    ).toMatchObject({
      app: null,
      action: null,
    });
    expect(
      createConnectedActionFailure('input', 'gmail', 'GMAIL_SEND_EMAIL?token=private')
    ).toMatchObject({
      app: 'gmail',
      action: null,
    });
  });
});

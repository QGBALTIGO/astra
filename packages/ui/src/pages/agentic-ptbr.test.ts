import { describe, expect, it } from 'vitest';
import {
  AGENTIC_STATUS_LABELS,
  CAPABILITY_PT_BR,
  EXECUTOR_KIND_LABELS,
  localizedCapability,
} from './agentic-ptbr';

describe('Traduções da central automatizada', () => {
  it('exibe os agentes e seus estados em português sem alterar os IDs da API', () => {
    expect(EXECUTOR_KIND_LABELS.claw).toBe('Agente autônomo');
    expect(EXECUTOR_KIND_LABELS.coding_agent).toBe('Agente de programação');
    expect(AGENTIC_STATUS_LABELS.running).toBe('Em execução');
    expect(AGENTIC_STATUS_LABELS.partially_completed).toBe('Parcialmente concluída');
  });

  it('apresenta nomes e descrições das capacidades padrão em pt-BR', () => {
    expect(Object.keys(CAPABILITY_PT_BR).length).toBeGreaterThanOrEqual(20);
    const cap = {
      id: 'claw:continuous-autonomy',
      name: 'Continuous Autonomous Execution',
      description: 'Runs an autonomous claw agent in a continuous loop',
      executorKind: 'claw',
    };
    const translated = localizedCapability(cap);
    expect(translated.id).toBe(cap.id);
    expect(translated.executorKind).toBe('claw');
    expect(translated.name).toBe('Execução autônoma contínua');
    expect(translated.description).toContain('agente autônomo');
    expect(cap.name).toBe('Continuous Autonomous Execution');
  });

  it('preserva capacidades customizadas ainda não traduzidas', () => {
    const custom = {
      id: 'custom:example',
      name: 'Capacidade personalizada',
      description: 'Definida pelo usuário',
    };
    expect(localizedCapability(custom)).toEqual(custom);
  });
});

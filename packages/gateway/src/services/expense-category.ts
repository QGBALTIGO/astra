import type { ExpenseCategory } from '../db/repositories/expenses.js';

/** Use the same Portuguese vocabulary in channel receipts and assistant tools. */
export function inferExpenseCategory(description: string): ExpenseCategory {
  const text = description.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (/\b(?:cafeteiras?|(?:maquinas?|moedores?|filtros?) (?:de |para )cafe)\b/u.test(text))
    return 'shopping';
  if (
    /\b(?:guardanapos?|embalagens?|papel toalha|copos? descartaveis?|talheres? descartaveis?)\b/u.test(
      text
    )
  )
    return 'shopping';
  if (
    /\b(?:almoco|jantar|cafes?|cafezinhos?|cafeterias?|sucos?|refrigerantes?|chas?|sanduiches?|hamburguer|hamburgueres|paes|pao|lanche|padaria|restaurante|mercado|supermercado|ifood|pizza|comida|refeicao|alimentacao)\b/u.test(
      text
    )
  )
    return 'food';
  if (
    /\b(?:uber|taxi|gasolina|combustivel|onibus|metro|transporte|estacionamento|pedagio)\b/u.test(
      text
    )
  )
    return 'transport';
  if (/\b(?:farmacia|remedio|medicamento|consulta|dentista|exame|saude)\b/u.test(text))
    return 'health';
  if (/\b(?:netflix|spotify|assinatura)\b/u.test(text)) return 'subscription';
  if (/\b(?:internet|energia|luz|agua|telefone)\b/u.test(text)) return 'utilities';
  if (/\b(?:aluguel|condominio|moradia)\b/u.test(text)) return 'housing';
  return 'other';
}

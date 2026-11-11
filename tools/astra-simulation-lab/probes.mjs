// Probe real, dependency-free TypeScript functions from Astra source. No DB or network.
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
async function loadActualFunctions(rel,start,end,names){
  const body=await readFile(join(ROOT,rel),'utf8');
  const a=body.indexOf(start),b=body.indexOf(end,a+start.length);
  if(a<0||b<0)throw Error('Source probe cannot find anchors in '+rel);
  const slice=body.slice(a,b).replace(/(^|\n)export (?=function|interface|type|const)/g,'$1');
  const runnable=stripTypeScriptTypes(slice,{mode:'strip'});
  return runInNewContext(runnable+'\n;({'+names.join(',')+'})',{}, {timeout:2000,filename:rel});
}
export async function runSourceProbes(){
  const problems=[];let total=0,passed=0;
  const check=(id,source,actual,expected,severity='P2')=>{
    total++;
    const a=JSON.stringify(actual),e=JSON.stringify(expected);
    if(a===e){passed++;return;}
    problems.push({
      id,category:'source-code-regression',severity,input:id,
      expected,observed:actual,source,
      possibleCause:'Verificar o parser/roteador na origem, sem mascarar a resposta.',
      reproduction:'node tools/astra-simulation-lab/lab.mjs probe --out <isolated output>',
      state:'not a database integration test',fixed:false,revalidated:false
    });
  };
  const reminder=await import(pathToFileURL(join(ROOT,'packages/gateway/src/channels/relative-reminder.ts')).href);
  const selection=await import(pathToFileURL(join(ROOT,'packages/gateway/src/channels/tool-selection.ts')).href);
  const {parseBrlCents,parseChannelExpense}=await loadActualFunctions(
    'packages/gateway/src/channels/finance-routing.ts',
    'function normalize(text:', '/** Record a fully specified expense',
    ['parseBrlCents','parseChannelExpense']);
  const {parseChannelFinanceRecord}=await loadActualFunctions(
    'packages/gateway/src/channels/customer-finance-routing.ts',
    'function normalize(text:', 'function calendarDay(',
    ['parseChannelFinanceRecord']);

  // Fixed-money assertions execute Astra's real parser functions, extracted without DB imports.
  const amounts=[
    ['1',100],['20',2000],['0,01',1],['0,50',50],['1,99',199],
    ['470',47000],['930',93000],['1.000',100000],['1.234,56',123456],
    ['72.000',7200000],['1.000.000,01',100000001],['1.2',120],
    ['0',null],['0,00',null],['9..2',null],['-1',null],['abc',null],
  ];
  for(const [input,expected] of amounts)
    check('BRL_'+input,'packages/gateway/src/channels/finance-routing.ts',
      parseBrlCents(input),expected,'P1');
  check('BRL_72_mil','finance-routing.ts',parseBrlCents('72','mil'),7200000,'P1');
  for(const [text,cents] of [
    ['gastei 1 real no cafe',100],['gastei R$ 20 no mercado',2000],
    ['paguei 470 de gasolina',47000],['paguei 0,01 no mercado',1],
    ['paguei 1.234,56 na farmacia',123456]
  ]) check('expense_'+text,'finance-routing.ts',
    parseChannelExpense(text)?.amountCents??null,cents,'P1');
  for(const text of [
    'nao gastei 20 no mercado','paguei 930','paguei 930 no carro e 20 no cafe',
    'talvez paguei 20 no mercado','paguei 470 na parcela',
    'paguei 20 no mercado ontem'
  ])check('unsafe_expense_'+text,'finance-routing.ts',parseChannelExpense(text),null,'P1');
  for(const [text,cents] of [
    ['recebi 1 real de freela',100],['recebi R$ 20 de servico',2000],
    ['tenho a receber R$ 470 de venda',47000],
    ['vou pagar R$ 1 de aluguel',100]
  ])check('customer_finance_'+text,'customer-finance-routing.ts',
      parseChannelFinanceRecord(text)?.amountCents??null,cents,'P1');

  for(const [text,expected] of [
    ['me lembra em 20 segundos de beber agua',20],
    ['me lembra em 40 minutos de caminhar',2400],
    ['me lembra em 1.000 segundos de conferir o caixa',1000],
    ['me lembra em 1 hora e 30 minutos de sair',5400],
  ])check('relative_reminder_'+text,'relative-reminder.ts',
    reminder.parseRelativeReminderRequest(text)?.delaySeconds??null,expected,'P1');
  check('relative_reminder_zero','relative-reminder.ts',
    reminder.parseRelativeReminderRequest('me lembra em 0 segundos de sair')?.kind,'invalid','P1');
  check('relative_reminder_duplicated_unit','relative-reminder.ts',
    reminder.parseRelativeReminderRequest('me lembra em 1 hora e 2 horas de sair'),null,'P2');

  for(const [text,tool] of [
    ['Me lembra amanhã de pagar a conta','core.schedule_channel_reminder'],
    ['gastei 1 real no cafe','core.record_transaction'],
    ['quero juntar 5 mil','core.create_goal'],
    ['minha meta é economizar R$ 20 mil','core.create_goal'],
    ['quanto falta para a minha meta','core.list_goals'],
    ['Preciso atualizar a meta de viagem','core.update_goal'],
  ])check('tool_selection_'+text,'tool-selection.ts',
    selection.channelToolsForMessage(text).includes(tool),true,'P2');
  check('tool_not_finance_cooking','tool-selection.ts',
    selection.channelToolsForMessage('Me ensina uma receita de bolo').includes('core.record_transaction'),
    false,'P2');
  check('tool_not_finance_recipe','tool-selection.ts',
    selection.channelToolsForMessage('quero uma receita de frango').includes('core.record_transaction'),
    false,'P2');

  // Thousands of exact-value properties over the real pure parsing functions.
  // These are source assertions, never WhatsApp/LLM or persistence successes.
  const format = new Intl.NumberFormat('pt-BR', {minimumFractionDigits:2,maximumFractionDigits:2});
  for(let i=1;i<=2000;i++) {
    const cents=1 + (i*9973 % 9999999);
    const amount=format.format(cents/100);
    check('money_property_'+i,'finance-routing.ts',parseBrlCents(amount),cents,'P1');
    check('expense_property_'+i,'finance-routing.ts',
      parseChannelExpense('gastei R$ '+amount+' no mercado')?.amountCents??null,cents,'P1');
    if(i<=1000) {
      check('income_property_'+i,'customer-finance-routing.ts',
        parseChannelFinanceRecord('recebi R$ '+amount+' de salario')?.amountCents??null,cents,'P1');
      const duration=1+(i*17%3600);
      check('reminder_property_'+i,'relative-reminder.ts',
        reminder.parseRelativeReminderRequest('me lembra em '+duration+' segundos de beber agua')?.delaySeconds??null,
        duration,'P1');
    }
  }
  check('unsafe_expense_financing_downpayment','finance-routing.ts',
    parseChannelExpense('paguei 470 de entrada'),null,'P1');

  return {mode:'real-Astra-source-probes',description:
    'Pure parsers and tool selection executed from actual checked-out Astra TypeScript; not DB, model, delivery, or full pipeline.',
    total,passed,failed:problems.length,issues:problems,
    guardrails:{databaseConnections:0,llmCalls:0,whatsappMessages:0,productionRequests:0}};
}

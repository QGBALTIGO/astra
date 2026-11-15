import { formatAstraMessage } from '../channels/response-presentation.js';

/** Offline and cost-free: do not promise a daily web search without a provider. */
export const DAILY_CURIOSITIES = [
  'Os polvos têm três corações.',
  'A luz do Sol leva cerca de 8 minutos e 20 segundos para chegar à Terra.',
  'As abelhas podem se comunicar por meio de uma dança.',
  'Os corais são animais, e não plantas.',
  'Saturno tem densidade média menor que a da água.',
  'O som não se propaga no vácuo.',
  'A Antártida é considerada o maior deserto da Terra.',
  'A Lua se afasta da Terra alguns centímetros a cada ano.',
  'O café é feito das sementes dos frutos do cafeeiro.',
  'Vênus demora mais para girar sobre si mesmo do que para dar uma volta no Sol.',
  'A Terra é levemente achatada nos polos.',
  'Os pinguins têm penas, assim como outras aves.',
  'Existem fungos capazes de produzir luz por bioluminescência.',
  'O lado da Lua que não vemos também recebe luz solar.',
  'A pele é o maior órgão do corpo humano.',
  'Uma estrela pode ter diferentes cores conforme sua temperatura.',
  'As auroras polares são causadas pela interação de partículas solares com a atmosfera.',
  'O arco-íris pode formar um círculo completo quando observado do alto.',
  'O planeta Júpiter completa uma rotação em menos de 10 horas.',
  'A neve pode formar cristais com simetria de seis lados.',
  'A água ferve a temperaturas menores em grandes altitudes.',
  'As bananas são classificadas botanicamente como bagas.',
  'Há montanhas submersas no fundo dos oceanos.',
  'O campo magnético da Terra ajuda a desviar partículas do vento solar.',
  'Os camaleões mudam de cor também para se comunicar.',
  'As baleias são mamíferos e precisam subir para respirar.',
  'A eletricidade dos relâmpagos pode aquecer o ar rapidamente.',
  'A maioria das estrelas visíveis no céu noturno pertence à Via Láctea.',
  'A gravidade faz as marés variarem ao longo do dia.',
  'A água cobre cerca de 71% da superfície terrestre.',
  'Borboletas percebem sabores também com receptores nas patas.',
] as const;

export function dailyGreetingText(localDay: string, withCuriosity: boolean, ending = true): string {
  const ordinal = Math.floor(Date.parse(localDay + 'T12:00:00Z') / 86_400_000);
  const index =
    ((ordinal % DAILY_CURIOSITIES.length) + DAILY_CURIOSITIES.length) % DAILY_CURIOSITIES.length;
  return formatAstraMessage(
    '☀️ Bom dia!',
    withCuriosity ? [{ label: 'Curiosidade do dia', value: DAILY_CURIOSITIES[index]! }] : [],
    ending ? 'Que hoje seja um ótimo dia para você! ✨' : undefined
  );
}

/**
 * Virtual-time local calendar scheduling for the synthetic oracle ONLY.
 * Never creates a production reminder or talks to a real transport.
 */
const DAY_MS = 86_400_000;
function localParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',
  });
  const parts=formatter.formatToParts(new Date(date));
  const get = type => Number(parts.find(x=>x.type===type)?.value);
  const ret={
    year:get('year'),month:get('month'),day:get('day'),
    hour:get('hour'),minute:get('minute'),second:get('second'),
  };
  if (Object.values(ret).some(x=>!Number.isFinite(x)))
    throw new Error('Invalid synthetic local clock');
  return ret;
}
function wallTimestamp(parts) {
  return Date.UTC(parts.year,parts.month-1,parts.day,
    parts.hour,parts.minute,parts.second);
}
function instantAtWall(timeZone, wall) {
  let candidate=wall;
  for(let i=0;i<5;i++){
    const shown=wallTimestamp(localParts(new Date(candidate),timeZone));
    if(shown===wall)return new Date(candidate);
    candidate+=wall-shown;
  }
  if(wallTimestamp(localParts(new Date(candidate),timeZone))!==wall)
    throw new Error('Nonexistent or ambiguous synthetic wall clock');
  return new Date(candidate);
}
/** Schedule N local calendar dates after today's local date, at HH:mm. */
export function virtualLocalDayAt(now,timeZone,dayOffset,hour,minute=0) {
  if(!Number.isInteger(dayOffset)||dayOffset<0||dayOffset>100 ||
    !Number.isInteger(hour)||hour<0||hour>23 ||
    !Number.isInteger(minute)||minute<0||minute>59)
    throw new Error('Invalid virtual local calendar parameters');
  const p=localParts(now,timeZone);
  const wall=Date.UTC(p.year,p.month-1,p.day+dayOffset,hour,minute,0);
  return instantAtWall(timeZone,wall);
}
/** Next specified local weekday after now, respecting account time zone. */
export function nextVirtualWeekdayAt(now,timeZone,weekday,hour,minute=0) {
  if(!Number.isInteger(weekday)||weekday<0||weekday>6)
    throw new Error('Invalid virtual weekday');
  const p=localParts(now,timeZone);
  const todayDow=new Date(Date.UTC(p.year,p.month-1,p.day)).getUTCDay();
  let offset=(weekday-todayDow+7)%7;
  for(let i=0;i<2;i++){
    const instant=virtualLocalDayAt(now,timeZone,offset,hour,minute);
    if(instant.getTime()>new Date(now).getTime())return instant;
    offset+=7;
  }
  throw new Error('Unable to schedule synthetic weekday');
}
export const VIRTUAL_DAY_MS=DAY_MS;

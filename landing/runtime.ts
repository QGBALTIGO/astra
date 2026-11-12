/** Astra landing runtime. Public assets are assembled by build.mjs.
 * Form validation, CSRF, idempotency, deletion and SQL contracts are retained.
 */
import { SQL } from 'bun';
import { brotliDecompressSync, gzipSync } from 'node:zlib';
import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
const RELEASE='premium-20261112';
/* PUBLIC_ASSET_BUNDLE */
const preview=Bun.env.LANDING_PREVIEW==='true';
const schema=preview?'astra_landing_preview':'astra_landing';
const publicOrigin=preview?'https://'+Bun.env.RAILWAY_PUBLIC_DOMAIN:'https://astra-landing-production.up.railway.app';
const secret=createHash('sha256').update(String(Bun.env.LANDING_PG_PASSWORD)+'|astra-landing-private-form-v1').digest();
const digest=value=>createHash('sha256').update(value).digest('hex');
const mac=value=>createHmac('sha256',secret).update(value).digest('hex');
const sql=new SQL({hostname:Bun.env.LANDING_PG_HOST,port:5432,username:Bun.env.LANDING_PG_USER,password:Bun.env.LANDING_PG_PASSWORD,database:Bun.env.LANDING_PG_DATABASE,max:2,idleTimeout:10,connectionTimeout:8,connection:{application_name:'astra-landing',search_path:schema,statement_timeout:'5000'}});
if(!Bun.env.LANDING_PG_PASSWORD||!Bun.env.LANDING_PG_HOST)throw Error('Landing database configuration missing');
await sql.unsafe('CREATE SCHEMA IF NOT EXISTS '+schema);
await sql`CREATE TABLE IF NOT EXISTS requests (
 id uuid PRIMARY KEY, request_key uuid NOT NULL UNIQUE, fingerprint char(64) NOT NULL,
 email varchar(254) NOT NULL, name varchar(80) NOT NULL DEFAULT '', intent varchar(12) NOT NULL CHECK(intent IN ('interesse','contato')),
 message varchar(1500) NOT NULL DEFAULT '', consent_version varchar(40) NOT NULL,
 cancellation_hash char(64) NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '90 days')`;
await sql`CREATE TABLE IF NOT EXISTS rate_limits (bucket varchar(140) PRIMARY KEY,hits integer NOT NULL DEFAULT 1,expires_at timestamptz NOT NULL)`;
await sql`CREATE TABLE IF NOT EXISTS events (day date NOT NULL,event varchar(32) NOT NULL,total bigint NOT NULL DEFAULT 1,PRIMARY KEY(day,event))`;
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; upgrade-insecure-requests";
const headers={'x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'strict-origin-when-cross-origin','permissions-policy':'camera=(), microphone=(), geolocation=()','content-security-policy':CSP};
const types={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'application/javascript; charset=utf-8',svg:'image/svg+xml',png:'image/png',woff2:'font/woff2'};
const assets=new Map(Object.entries(files).map(([path,body])=>{
 const raw=String(body).startsWith('BASE64:')?Buffer.from(String(body).slice(7),'base64'):Buffer.from(String(body));
 const ext=path.split('.').at(-1),type=types[ext]||'application/octet-stream';
 return [path,{raw,gzip:gzipSync(raw),type,etag:'W/"'+digest(raw)+'"'}];
}));
function json(value,status=200,extra={}){return Response.json(value,{status,headers:{...headers,'cache-control':'no-store',...extra}})}
function error(message,status){return json({error:message},status)}
function formToken(){const v=Date.now()+'.'+randomUUID();return v+'.'+mac(v)}
function validToken(value){
 if(!value||value.length>150)return false;
 const pieces=value.split('.');if(pieces.length!==3||!/^\d{13}$/.test(pieces[0])||!/^[a-f0-9]{64}$/.test(pieces[2]))return false;
 const age=Date.now()-Number(pieces[0]);if(age<0||age>1200000)return false;
 return timingSafeEqual(Buffer.from(pieces[2],'hex'),Buffer.from(mac(pieces[0]+'.'+pieces[1]),'hex'));
}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function validate(input){
 if(!input||typeof input!=='object'||Array.isArray(input))return null;
 const email=typeof input.email==='string'?input.email.trim().toLowerCase():'';
 const name=typeof input.name==='string'?input.name.trim():'';
 const message=typeof input.message==='string'?input.message.trim():'';
 const intent=input.intent;
 if(input.consent!==true||!['interesse','contato'].includes(intent)||!UUID.test(input.requestId||'')||input.website)return null;
 if(email.length>254||! /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]{2,}$/.test(email)||name.length>80||message.length>1500||(intent==='contato'&&message.length<10))return null;
 if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(name+message+email))return null;
 return {email,name,message:intent==='contato'?message:'',intent,requestId:input.requestId};
}
let lastCleanup=0;
async function cleanup(){
 if(Date.now()-lastCleanup<3600000)return;
 await sql`DELETE FROM requests WHERE expires_at < now()`;
 await sql`DELETE FROM rate_limits WHERE expires_at < now()`;
 await sql`DELETE FROM events WHERE day < current_date - 180`;
 lastCleanup=Date.now();
}
async function rate(bucket,limit,ttl){
 const expiry=new Date(Date.now()+ttl);
 const rows=await sql`INSERT INTO rate_limits(bucket,expires_at) VALUES(${bucket},${expiry}) ON CONFLICT(bucket) DO UPDATE SET hits=rate_limits.hits+1 RETURNING hits`;
 return Number(rows[0].hits)<=limit;
}
async function count(event){await sql`INSERT INTO events(day,event) VALUES(current_date,${event}) ON CONFLICT(day,event) DO UPDATE SET total=events.total+1`;}
const ephemeral=new Map();
function localLimit(key,limit=60){
 const now=Date.now();let item=ephemeral.get(key);
 if(!item||item.until<now){item={hits:0,until:now+60000};ephemeral.set(key,item)}
 if(ephemeral.size>10000){for(const [k,v] of ephemeral){if(v.until<now)ephemeral.delete(k)}if(ephemeral.size>10000)return false;}
 return ++item.hits<=limit;
}
async function save(input,ipHash){
 const row=validate(input);if(!row)return error('Confira o e-mail, a mensagem e a autorização de contato.',422);
 const fingerprint=mac(JSON.stringify([row.email,row.name,row.intent,row.message]));
 const cancellationToken=mac('cancel|'+row.requestId+'|'+fingerprint);
 const prior=await sql`SELECT id,fingerprint FROM requests WHERE request_key=${row.requestId}::uuid AND expires_at>now()`;
 if(prior.length){if(prior[0].fingerprint!==fingerprint)return error('Reabra o formulário para iniciar uma nova solicitação.',409);return json({receipt:'ASTRA-'+prior[0].id,cancellationToken},200)}
 const hour=Math.floor(Date.now()/3600000),day=Math.floor(Date.now()/86400000);
 if(!await rate('ip:'+hour+':'+ipHash,20,7200000)||!await rate('email:'+day+':'+mac(row.email),5,172800000))return json({error:'Muitas tentativas. Tente novamente mais tarde.'},429,{'retry-after':'3600'});
 const id=randomUUID(),hash=digest(cancellationToken);
 const inserted=await sql`INSERT INTO requests(id,request_key,fingerprint,email,name,intent,message,consent_version,cancellation_hash)
 VALUES(${id}::uuid,${row.requestId}::uuid,${fingerprint},${row.email},${row.name},${row.intent},${row.message},${'landing-20261110'},${hash})
 ON CONFLICT(request_key) DO NOTHING RETURNING id`;
 if(!inserted.length){const existing=await sql`SELECT id,fingerprint FROM requests WHERE request_key=${row.requestId}::uuid`;if(!existing.length||existing[0].fingerprint!==fingerprint)return error('Reabra o formulário para iniciar uma nova solicitação.',409);return json({receipt:'ASTRA-'+existing[0].id,cancellationToken},200)}
 await count(row.intent==='contato'?'contact_saved':'interest_saved').catch(()=>{});
 return json({receipt:'ASTRA-'+id,cancellationToken},201);
}
const routes={'/':'/index.html','/index.html':'/index.html','/privacidade':'/privacidade.html','/condicoes':'/condicoes.html','/remover':'/remover.html'};
function staticResponse(req,path,status=200){
 const a=assets.get(path);if(!a)return staticResponse(req,'/404.html',404);
 const h={...headers,'content-type':a.type,'cache-control':/\-[a-f0-9]{12}\./.test(path)?'public, max-age=31536000, immutable':'no-cache, max-age=0, must-revalidate',etag:a.etag,vary:'Accept-Encoding'};
 if(preview||path==='/remover.html'||status===404)h['x-robots-tag']='noindex, nofollow';
 if(req.headers.get('if-none-match')===a.etag&&status===200)return new Response(null,{status:304,headers:h});
 const useGzip=/(?:^|,)\s*gzip(?:\s*;q=(?!0(?:\.0*)?(?:\s|,|$))[\d.]+)?(?:\s*,|\s*$)/i.test(req.headers.get('accept-encoding')||'');
 const body=useGzip?a.gzip:a.raw;if(useGzip)h['content-encoding']='gzip';h['content-length']=String(body.length);
 return new Response(req.method==='HEAD'?null:body,{status,headers:h});
}
async function handle(req){
 const u=new URL(req.url),path=u.pathname,method=req.method;
 if(path==='/health'){
  if(!['GET','HEAD'].includes(method))return json({error:'Método não permitido'},405,{allow:'GET, HEAD'});
  return new Response(method==='HEAD'?null:JSON.stringify({status:'ok',service:'astra-landing',release:RELEASE,preview}),{headers:{...headers,'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
 }
 if(path.startsWith('/api/')){
  if(!['/api/form-token','/api/interesse','/api/remover','/api/evento'].includes(path))return error('Página não encontrada',404);
  const ip=mac((req.headers.get('x-real-ip')||'unknown').slice(0,100)+'|'+Math.floor(Date.now()/86400000));
  if(!localLimit(ip,path==='/api/evento'?60:30))return json({error:'Muitas tentativas. Aguarde antes de tentar novamente.'},429,{'retry-after':'60'});
  if(path==='/api/form-token'){
   if(method!=='GET')return json({error:'Método não permitido'},405,{allow:'GET'});
   if(req.headers.get('sec-fetch-site')==='cross-site')return error('Origem não permitida',403);
   return json({token:formToken()});
  }
  if(method!=='POST')return json({error:'Método não permitido'},405,{allow:'POST'});
  if(req.headers.get('origin')!==publicOrigin||!req.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return error('Origem ou formato não permitido',403);
  if(Number(req.headers.get('content-length')||0)>8192)return error('Solicitação muito grande',413);
  if(path!=='/api/evento'&&!validToken(req.headers.get('x-astra-form-token')))return error('O formulário expirou. Tente enviar novamente.',403);
  let input;try{const text=await req.text();if(Buffer.byteLength(text)>8192)return error('Solicitação muito grande',413);input=JSON.parse(text)}catch{return error('Solicitação inválida',400)}
  if(!input||typeof input!=='object'||Array.isArray(input))return error('Solicitação inválida',400);
  await cleanup();
  if(path==='/api/evento'){
   if(req.headers.get('dnt')==='1'||req.headers.get('sec-gpc')==='1')return new Response(null,{status:204,headers});
   if(!['plan_view','interest_open','contact_open','form_error'].includes(input.event))return error('Evento inválido',422);
   if(!await rate('event:'+Math.floor(Date.now()/3600000)+':'+ip,120,7200000))return new Response(null,{status:204,headers});
   await count(input.event);return new Response(null,{status:204,headers});
  }
  if(path==='/api/remover'){
   if(typeof input.token!=='string'||!/^[a-f0-9]{64}$/.test(input.token))return error('Link de remoção inválido',422);
   await sql`DELETE FROM requests WHERE cancellation_hash=${digest(input.token)}`;
   return json({removed:true});
  }
  return save(input,ip);
 }
 if(!['GET','HEAD'].includes(method))return json({error:'Método não permitido'},405,{allow:'GET, HEAD'});
 if(path==='/robots.txt')return new Response(method==='HEAD'?null:(preview?'User-agent: *\nDisallow: /\n':'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /remover\nSitemap: '+publicOrigin+'/sitemap.xml\n'),{headers:{...headers,'content-type':'text/plain; charset=utf-8'}});
 if(path==='/sitemap.xml')return new Response(method==='HEAD'?null:'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+['/','/privacidade','/condicoes'].map(x=>'<url><loc>'+publicOrigin+x+'</loc></url>').join('')+'</urlset>',{headers:{...headers,'content-type':'application/xml; charset=utf-8'}});
 if(path==='/favicon.ico')return Response.redirect(publicOrigin+'/assets/brand-ac0b1367fee7.png',302);
 if(routes[path])return staticResponse(req,routes[path]);
 if(path.startsWith('/assets/')&&assets.has(path))return staticResponse(req,path);
 return staticResponse(req,'/404.html',404);
}
await cleanup();
Bun.serve({hostname:'0.0.0.0',port:Number(Bun.env.PORT||8080),maxRequestBodySize:8192,idleTimeout:15,
 async fetch(req){try{return await handle(req)}catch{console.error('ASTRA_LANDING_REQUEST_FAILED');return error('Não foi possível salvar agora. Tente novamente.',503)}},
 error(){return error('Não foi possível concluir a solicitação.',500)}
});
console.log(JSON.stringify({event:'astra_landing_ready',release:RELEASE,preview,assetCount:assets.size}));

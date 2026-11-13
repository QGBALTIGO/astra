"""Read-only public release verification. Build first; run with Python 3. No production writes."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import urllib.request, urllib.error, json, base64, gzip, hashlib, sys
root=Path(__file__).resolve().parents[1]
base='https://astraacessor.pro'
def get(path):
 req=urllib.request.Request(base+path,headers={'Accept-Encoding':'identity','DNT':'1','User-Agent':'Astra-release-verification/1.0'})
 try:
  response=urllib.request.urlopen(req,timeout=25)
 except urllib.error.HTTPError as response:
  data=response.read();return response.code,dict(response.headers),data
 data=response.read();headers=dict(response.headers)
 if headers.get('Content-Encoding')=='gzip': data=gzip.decompress(data)
 return response.status,headers,data
if '--baseline' in sys.argv:
 status,headers,body=get('/health');print(json.dumps({'status':status,'health':json.loads(body)},ensure_ascii=False));sys.exit()
bundle=json.loads((root/'dist/bundle.json').read_text());build=json.loads((root/'dist/build.json').read_text())
def verify(entry):
 file,value=entry
 path='/' if file=='/index.html' else file[:-5] if file.endswith('.html') else file
 status,headers,body=get(path)
 expected=base64.b64decode(value[7:]) if value.startswith('BASE64:') else value.encode()
 assert status==(404 if file=='/404.html' else 200),(path,status)
 assert body==expected,(path,'published bytes differ',hashlib.sha256(body).hexdigest())
 assert headers.get('X-Frame-Options',headers.get('x-frame-options'))=='DENY',path
 return {'path':path,'bytes':len(body)}
with ThreadPoolExecutor(max_workers=4) as pool: verified=list(pool.map(verify,bundle.items()))
status,_,body=get('/health');health=json.loads(body)
assert status==200 and health['release']==build['release'] and health['preview'] is False,health
status,_,sitemap=get('/sitemap.xml');assert status==200
public=['/','/privacidade','/condicoes','/demonstracao','/financas','/agenda','/lembretes','/tarefas','/metas','/notas','/como-usar','/seguranca','/sobre','/suporte']
for path in public:assert ('<loc>'+base+path+'</loc>').encode() in sitemap,path
assert b'/remover' not in sitemap
unknown_status,_,_=get('/not-a-real-astra-route');assert unknown_status==404
status,_,robots=get('/robots.txt');assert status==200 and b'Disallow: /\n' not in robots
print(json.dumps({'release':health['release'],'bundle_sha256':build['sha256'],'verified_files':len(verified),'public_sitemap_urls':len(public),'unknown_route_status':unknown_status,'exact_bytes':True,'preview':health['preview']},ensure_ascii=False))

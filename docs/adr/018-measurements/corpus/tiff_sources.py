#!/usr/bin/env python3 -I
"""Build tab-separated source<TAB>url sample list for tiff_probe. Seeded random."""
import random,re,json,urllib.request,urllib.parse,sys
random.seed(18)
def get(u,t=40): return urllib.request.urlopen(u,timeout=t).read().decode('utf8','replace')
def s3list(bucket_host,prefix,maxk=1000,token=None,delim=None):
    u=f'https://{bucket_host}/?list-type=2&max-keys={maxk}&prefix={urllib.parse.quote(prefix)}'
    if delim: u+='&delimiter='+delim
    if token: u+='&continuation-token='+urllib.parse.quote(token)
    x=get(u); return re.findall(r'<Key>([^<]+)</Key>',x),re.findall(r'<Prefix>([^<]+)</Prefix>',x),re.search(r'<NextContinuationToken>([^<]+)',x)
out=[]
def add(src,urls,k):
    urls=list(dict.fromkeys(urls)); random.shuffle(urls)
    for u in urls[:k]: out.append((src,u))
    print(src,len(urls),'candidates',min(k,len(urls)),'taken',file=sys.stderr)
# Copernicus DEM 30m COG: sample across latitude bands
h='copernicus-dem-30m.s3.amazonaws.com'; c=[]
for lat in ['N00','N10','N20','N30','N40','N50','S10','S20','S30']:
    ks,_,_=s3list(h,f'Copernicus_DSM_COG_10_{lat}',1000); c+= [f'https://{h}/{k}' for k in ks if k.endswith('_DEM.tif')]
add('copernicus-dem-30m',c,40)
# ESA WorldCover
h='esa-worldcover.s3.eu-central-1.amazonaws.com'; c=[]; tok=None
for _ in range(3):
    ks,_,tok=s3list(h,'v200/2021/map/',1000,tok and tok.group(1)); c+=[f'https://{h}/{k}' for k in ks if k.endswith('.tif')]
    if not tok: break
add('esa-worldcover-2021',c,30)
# USGS 3DEP 1/3 arcsec staged tif + 1m projects
h='prd-tnm.s3.amazonaws.com'; c=[]
_,pfx,_=s3list(h,'StagedProducts/Elevation/13/TIFF/current/',1000,delim='/')
for p in random.sample(pfx,min(40,len(pfx))):
    ks,_,_=s3list(h,p,50); c+=[f'https://{h}/{k}' for k in ks if k.endswith('.tif')]
add('usgs-3dep-13arcsec',c,30)
_,pfx,_=s3list(h,'StagedProducts/Elevation/1m/Projects/',1000,delim='/'); c=[]
for p in random.sample(pfx,min(12,len(pfx))):
    ks,_,_=s3list(h,p+'TIFF/',30); c+=[f'https://{h}/{k}' for k in ks if k.endswith('.tif')]
add('usgs-3dep-1m',c,30)
# Hansen GFC
c=[f'https://storage.googleapis.com/earthenginepartners-hansen/GFC-2023-v1.11/Hansen_GFC-2023-v1.11_{l}_{a:02d}{ns}_{b:03d}{ew}.tif' for l in ('treecover2000','lossyear','datamask') for a,ns in ((10,'N'),(20,'N'),(30,'N'),(40,'N'),(50,'N'),(0,'N'),(10,'S')) for b,ew in ((0,'E'),(10,'E'),(100,'E'),(130,'E'),(10,'W'),(60,'W'),(80,'W'),(120,'W'))]
add('hansen-gfc-2023',c,24)
# WorldPop
idx=get('https://data.worldpop.org/GIS/Population/Global_2000_2020/2020/')
cc=re.findall(r'href="([A-Z]{3})/"',idx); c=[]
for x in random.sample(cc,min(40,len(cc))): c.append(f'https://data.worldpop.org/GIS/Population/Global_2000_2020/2020/{x}/{x.lower()}_ppp_2020.tif')
add('worldpop-ppp-2020',c,40)
# OpenAerialMap
c=[]
for pg in range(1,6):
    j=json.loads(get(f'https://api.openaerialmap.org/meta?limit=100&page={random.randint(1,200)}'))
    c+=[r['uuid'] for r in j['results'] if r.get('uuid','').lower().endswith(('.tif','.tiff'))]
add('openaerialmap',c,80)
# Sentinel-2 L2A COG (COG by design)
j=json.loads(get('https://earth-search.aws.element84.com/v1/search?collections=sentinel-2-l2a&limit=30&datetime=2025-06-01T00:00:00Z/2025-06-30T00:00:00Z'))
c=[]
for f in j['features']:
    for k in ('red','nir','visual'):
        if k in f['assets']: c.append(f['assets'][k]['href'])
add('sentinel2-l2a-cog',c,30)
with open(sys.argv[1],'w') as f:
    for s,u in out: f.write(s+'\t'+u+'\n')

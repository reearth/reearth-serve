#!/usr/bin/env python3 -I
"""Second corpus of zip-format files. Output: URLs, one per line, source<TAB>url. Seeded."""
import random,re,json,urllib.request,sys
random.seed(18)
def get(u,t=40): return urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'zip-survey/1'}),timeout=t).read().decode('utf8','replace')
out=[]
def add(src,urls,k):
    urls=list(dict.fromkeys(urls)); random.shuffle(urls)
    out.extend((src,u) for u in urls[:k]); print(src,len(urls),min(k,len(urls)),file=sys.stderr)
# Natural Earth
x=get('https://naturalearth.s3.amazonaws.com/?max-keys=1000')
add('naturalearth',['https://naturalearth.s3.amazonaws.com/'+k for k in re.findall(r'<Key>([^<]+\.zip)</Key>',x)],120)
# Census TIGER 2023 (shapefile zips)
c=[]
for d in ('TRACT','COUNTY','PLACE','EDGES','ROADS','AREAWATER','TABBLOCK20'):
    try:
        h=get(f'https://www2.census.gov/geo/tiger/TIGER2023/{d}/')
        c+=[f'https://www2.census.gov/geo/tiger/TIGER2023/{d}/{f}' for f in re.findall(r'href="([^"]+\.zip)"',h)]
    except Exception as e: print(d,e,file=sys.stderr)
add('census-tiger-2023',c,120)
# PyPI wheels (zip), top packages
top=json.loads(get('https://hugovk.github.io/top-pypi-packages/top-pypi-packages.min.json'))['rows'][:3000]
c=[]
for r in random.sample(top,160):
    try:
        j=json.loads(get(f"https://pypi.org/pypi/{r['project']}/json",20))
        c+=[u['url'] for u in j['urls'] if u['filename'].endswith('.whl')][:1]
    except Exception as e: pass
add('pypi-wheel',c,150)
# Maven Central jars from a few well-known groups
c=[]
for p in ('org/apache/commons','com/google/guava','org/slf4j','org/jsoup','junit','com/fasterxml/jackson/core','org/yaml','commons-io','org/apache/httpcomponents','org/apache/logging/log4j'):
    try:
        h=get(f'https://repo1.maven.org/maven2/{p}/')
        for a in re.findall(r'href="([^"/]+)/"',h)[:6]:
            if a.startswith('.'): continue
            try:
                m=get(f'https://repo1.maven.org/maven2/{p}/{a}/maven-metadata.xml',20)
                v=re.findall(r'<version>([^<]+)</version>',m)
                if v: c.append(f'https://repo1.maven.org/maven2/{p}/{a}/{v[-1]}/{a}-{v[-1]}.jar')
            except Exception: pass
    except Exception as e: print(p,e,file=sys.stderr)
add('maven-jar',c,60)
with open(sys.argv[1],'w') as f:
    for s,u in out: f.write(s+'\t'+u+'\n')

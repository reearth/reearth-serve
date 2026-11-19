#!/usr/bin/env python3 -I
"""For PLATEAU ortho zips: list entry extensions via CD, and probe TIFF layout of up to 3 tif entries each by reading the local entry prefix (stored or inflated prefix). usage: ortho_in_zip_tiff.py urls.txt out.jsonl"""
import sys,os,json,struct,zlib,collections,urllib.request,concurrent.futures as cf
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from tiff_probe import parse
def rng(u,a,b):
    r=urllib.request.urlopen(urllib.request.Request(u,headers={'Range':f'bytes={a}-{b}'}),timeout=40); d=r.read(); r.close(); return d
def one(u):
    try:
        t=urllib.request.urlopen(urllib.request.Request(u,headers={'Range':'bytes=-131072'}),timeout=40); tail=t.read(); size=int(t.headers['Content-Range'].split('/')[1]); ts=size-len(tail)
        i=tail.rfind(b'PK\x05\x06'); n,cdsz,cdoff=struct.unpack('<HII',tail[i+10:i+20])
        if n==0xFFFF or cdoff==0xFFFFFFFF:
            o=struct.unpack('<Q',tail[i-12:i-4])[0]; rec=tail[o-ts:o-ts+56] if o>=ts else rng(u,o,o+55); v=struct.unpack('<IQHHIIQQQQ',rec); n,cdsz,cdoff=v[7],v[8],v[9]
        cd=tail[cdoff-ts:cdoff-ts+cdsz] if cdoff>=ts else rng(u,cdoff,cdoff+cdsz-1)
        p=0; ext=collections.Counter(); tifs=[]
        while p+46<=len(cd):
            (_,_,_,fl,m,_,_,_,c,us,nl,el,cl,_,_,_,off)=struct.unpack('<IHHHHHHIIIHHHHHII',cd[p:p+46]); nm=cd[p+46:p+46+nl].decode('latin1')
            ex=cd[p+46+nl:p+46+nl+el]
            q=0
            while q+4<=len(ex):
                tt,ll=struct.unpack('<HH',ex[q:q+4])
                if tt==1:
                    f=ex[q+4:q+4+ll]; o=0
                    if us==0xFFFFFFFF: us=struct.unpack('<Q',f[o:o+8])[0]; o+=8
                    if c==0xFFFFFFFF: c=struct.unpack('<Q',f[o:o+8])[0]; o+=8
                    if off==0xFFFFFFFF: off=struct.unpack('<Q',f[o:o+8])[0]
                q+=4+ll
            e=nm.rsplit('.',1)[-1].lower() if '.' in nm.rsplit('/',1)[-1] else ''
            ext[e]+=1
            if e in ('tif','tiff'): tifs.append((nm,m,c,us,off))
            p+=46+nl+el+cl
        out=[]
        for nm,m,c,us,off in sorted(tifs,key=lambda t:t[2])[:2]:
            lh=rng(u,off,off+29); nl,el=struct.unpack('<HH',lh[26:30]); st=off+30+nl+el
            if c>40<<20: out.append({'err':'smallest tifs too large to fetch fully','entry':nm,'csize':c}); continue
            raw=rng(u,st,st+c-1)
            data=raw if m==0 else zlib.decompress(raw,-15)
            r=parse(lambda a,b:data[a:b+1]) if len(data)>16 else {'err':'short'}
            r['entry']=nm; r['method']=m; r['usize']=us; out.append(r)
        return {'url':u,'size':size,'entries':n,'ext':dict(ext),'tiffs':out}
    except Exception as e: return {'url':u,'err':repr(e)[:150]}
urls=[l.strip() for l in open(sys.argv[1]) if l.strip()]
with cf.ThreadPoolExecutor(4) as ex, open(sys.argv[2],'w') as f:
    for fu in cf.as_completed([ex.submit(one,u) for u in urls]): f.write(json.dumps(fu.result())+'\n'); f.flush()

#!/usr/bin/env python3 -I
"""M5: range-fetch bldg .gml deflate entries from a PLATEAU citygml zip, histogram LZ77 distances (own inflate), compare to zlib re-deflate levels.
usage: m5_gml_distances.py zip_url outdir [n_entries]"""
import sys,os,struct,urllib.request,zlib,json,random
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from deflate_dist import inflate_dist
def rng(u,a,b): return urllib.request.urlopen(urllib.request.Request(u,headers={'Range':f'bytes={a}-{b}'}),timeout=120).read()
u,outdir=sys.argv[1],sys.argv[2]; N=int(sys.argv[3]) if len(sys.argv)>3 else 3
os.makedirs(outdir,exist_ok=True); random.seed(18)
t=urllib.request.urlopen(urllib.request.Request(u,headers={'Range':'bytes=-131072'}),timeout=60); tail=t.read(); size=int(t.headers['Content-Range'].split('/')[1]); ts=size-len(tail)
i=tail.rfind(b'PK\x05\x06'); n,cdsz,cdoff=struct.unpack('<HII',tail[i+10:i+20])
if n==0xFFFF or cdoff==0xFFFFFFFF:
    o=struct.unpack('<Q',tail[i-12:i-4])[0]; rec=rng(u,o,o+55); v=struct.unpack('<IQHHIIQQQQ',rec); n,cdsz,cdoff=v[7],v[8],v[9]
cd=rng(u,cdoff,cdoff+cdsz-1); p=0; ents=[]
while p+46<=len(cd):
    (_,_,_,fl,m,_,_,crc,c,us,nl,el,cl,_,_,_,off)=struct.unpack('<IHHHHHHIIIHHHHHII',cd[p:p+46]); nm=cd[p+46:p+46+nl].decode('latin1')
    ents.append((nm,m,crc,c,us,off,cd[p+46+nl:p+46+nl+el])); p+=46+nl+el+cl
g=[e for e in ents if e[0].endswith('.gml') and '/bldg/' in e[0] and e[1]==8 and 2e6<e[4]<60e6]
print('zip',u,'entries',len(ents),'bldg gml (2-60MB, deflate)',len(g),file=sys.stderr)
res=[]
for nm,m,crc,c,us,off,ex in random.sample(g,min(N,len(g))):
    assert off!=0xFFFFFFFF
    lh=rng(u,off,off+29); nl,el=struct.unpack('<HH',lh[26:30]); data=rng(u,off+30+nl+el,off+30+nl+el+c-1)
    raw=zlib.decompress(data,-15); assert len(raw)==us and zlib.crc32(raw)==crc,'crc'
    open(os.path.join(outdir,os.path.basename(nm)),'wb').write(raw)
    lim=1<<30
    def stats(d,label,comp):
        N_=len(d); r={'label':label,'compressed':comp,'ratio':us/comp,'matches':N_}
        for k in (4096,8192,16384,24576): r[f'gt{k//1024}K']=round(sum(x>k for x in d)/N_,4)
        return r
    d,out,lits,mt,mb=inflate_dist(data,lim); assert out==us,(out,us)
    row={'entry':nm,'usize':us,'orig':stats(d,'as-distributed',c)}
    row['orig']['match_bytes_share']=round(mb/out,4)
    for lv in (1,6,9):
        co=zlib.compressobj(lv,zlib.DEFLATED,-15); z=co.compress(raw)+co.flush(); d2,o2,*_=inflate_dist(z,lim); row[f'zlib{lv}']=stats(d2,f'zlib -{lv}',len(z))
    res.append(row); print(json.dumps(row),flush=True)

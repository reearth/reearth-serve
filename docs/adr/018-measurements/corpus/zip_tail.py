#!/usr/bin/env python3 -I
"""Range-read zip EOCD+central directory for URLs; emit JSONL. usage: zip_tail.py urls.txt out.jsonl"""
import sys,struct,json,urllib.request,urllib.error,concurrent.futures as cf,collections
def rng(u,a,b=None):
    h={'Range':f'bytes={a}-{b if b is not None else ""}'}
    r=urllib.request.urlopen(urllib.request.Request(u,headers=h),timeout=40)
    d=r.read(); cr=r.headers.get('Content-Range')
    return d,cr
def one(u):
    try:
        d,cr=rng(u,-131072) if False else (None,None)
        req=urllib.request.Request(u,headers={'Range':'bytes=-131072'})
        try:
            r=urllib.request.urlopen(req,timeout=40); tail=r.read(); cr=r.headers.get('Content-Range')
        except urllib.error.HTTPError as he:
            if he.code!=416: raise
            r=urllib.request.urlopen(urllib.request.Request(u),timeout=60); tail=r.read(64<<20); cr=f'bytes 0-{len(tail)-1}/{len(tail)}'
        if not cr: return {'url':u,'err':'no range support'}
        size=int(cr.split('/')[1]); tstart=size-len(tail)
        i=tail.rfind(b'PK\x05\x06')
        if i<0: return {'url':u,'size':size,'err':'no EOCD in tail'}
        (_,_,_,n,n2,cdsz,cdoff,clen)=struct.unpack('<IHHHHIIH',tail[i:i+22])
        z64=False
        if (n==0xFFFF or cdsz==0xFFFFFFFF or cdoff==0xFFFFFFFF) and i>=20 and tail[i-20:i-16]==b'PK\x06\x07':
            z64=True
            _,_,off64,_=struct.unpack('<IIQI',tail[i-20:i])
            if off64>=tstart: rec=tail[off64-tstart:]
            else: rec,_=rng(u,off64,off64+63)
            _v=struct.unpack('<IQHHIIQQQQ',rec[:56]); n,cdsz,cdoff=_v[7],_v[8],_v[9]
        if cdoff>=tstart: cd=tail[cdoff-tstart:cdoff-tstart+cdsz]
        else: cd,_=rng(u,cdoff,cdoff+cdsz-1)
        meth=collections.Counter(); dd=0; nonutf=0; nonascii=0; nonascii_nonutf=0; ent=0; usz=0; csz=0; p=0; dirs=0
        while p+46<=len(cd) and cd[p:p+4]==b'PK\x01\x02':
            (_,_,_,flag,m,_,_,_,c,us,nl,el,cl,_,_,_,_)=struct.unpack('<IHHHHHHIIIHHHHHII',cd[p:p+46])
            name=cd[p+46:p+46+nl]
            ent+=1; meth[m]+=1
            if flag&8: dd+=1
            if not flag&0x800:
                nonutf+=1
            if any(b>127 for b in name):
                nonascii+=1
                if not flag&0x800: nonascii_nonutf+=1
            if name.endswith(b'/'): dirs+=1
            ex=cd[p+46+nl:p+46+nl+el]
            q=0
            while q+4<=len(ex):
                t,l=struct.unpack('<HH',ex[q:q+4])
                if t==1:
                    f=ex[q+4:q+4+l]; o=0
                    if us==0xFFFFFFFF: us=struct.unpack('<Q',f[o:o+8])[0]; o+=8
                    if c==0xFFFFFFFF: c=struct.unpack('<Q',f[o:o+8])[0]
                q+=4+l
            usz+=us; csz+=c
            p+=46+nl+el+cl
        return {'url':u,'size':size,'declared_n':n,'parsed_n':ent,'cd_bytes':cdsz,'zip64':z64,'dd':dd,'methods':dict(meth),
                'nonutf_flag':nonutf,'nonascii':nonascii,'nonascii_nonutf':nonascii_nonutf,'dirs':dirs,'usize':usz,'csize':csz}
    except Exception as e:
        return {'url':u,'err':repr(e)[:200]}
if __name__=='__main__':
    urls=[l.strip() for l in open(sys.argv[1]) if l.strip()]
    with cf.ThreadPoolExecutor(12) as ex, open(sys.argv[2],'w') as f:
        for fu in cf.as_completed([ex.submit(one,u) for u in urls]):
            r=fu.result(); f.write(json.dumps(r)+'\n'); f.flush()

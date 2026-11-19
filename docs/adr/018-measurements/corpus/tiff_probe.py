#!/usr/bin/env python3 -I
"""Range-read TIFF header+first IFD of URLs. usage: tiff_probe.py urls.tsv(source<TAB>url) out.jsonl"""
import sys,struct,json,urllib.request,concurrent.futures as cf
def rng(u,a,b):
    r=urllib.request.urlopen(urllib.request.Request(u,headers={'Range':f'bytes={a}-{b}'}),timeout=15)
    if r.status==200 and a>0: r.close(); raise ValueError('server ignores Range, IFD beyond start')
    d=r.read(b-a+1); r.close(); return d
SZ={1:1,2:1,3:2,4:4,5:8,6:1,7:1,8:2,9:4,10:8,11:4,12:8,16:8,17:8,18:8}
def parse(read,size_hint=None):
    h=read(0,65535)
    if h[:2]==b'II': e='<'
    elif h[:2]==b'MM': e='>'
    else: return {'err':'not tiff '+repr(h[:4])}
    ver=struct.unpack(e+'H',h[2:4])[0]
    big=ver==43
    if ver not in (42,43): return {'err':f'ver {ver}'}
    off=struct.unpack(e+'Q',h[8:16])[0] if big else struct.unpack(e+'I',h[4:8])[0]
    buf=h
    if off+2>len(h):
        buf=read(off,off+65535); base=off
    else: base=0
    p=off-base
    if big: n=struct.unpack(e+'Q',buf[p:p+8])[0]; p+=8; esz=20
    else: n=struct.unpack(e+'H',buf[p:p+2])[0]; p+=2; esz=12
    if p+n*esz>len(buf): buf=read(off,off+n*esz+16+8); base=off; p=(8 if big else 2)
    tags={}
    for i in range(n):
        q=p+i*esz
        if big: t,ty,cnt=struct.unpack(e+'HHQ',buf[q:q+12]); v=buf[q+12:q+20]; inl=8
        else: t,ty,cnt=struct.unpack(e+'HHI',buf[q:q+8]); v=buf[q+8:q+12]; inl=4
        if cnt*SZ.get(ty,1)<=inl:
            if ty==3 and cnt>=1: val=struct.unpack(e+'H',v[:2])[0]
            elif ty==4 and cnt>=1: val=struct.unpack(e+'I',v[:4])[0]
            elif ty==16 and cnt>=1: val=struct.unpack(e+'Q',v[:8])[0]
            else: val=None
        else: val=None
        tags[t]=(ty,cnt,val)
    g=lambda t:tags.get(t,(0,0,None))[2]
    tiled=322 in tags and 324 in tags
    stripped=273 in tags
    return {'bigtiff':big,'tiled':tiled,'stripped':stripped and not tiled,'tilew':g(322),'tileh':g(323),'rps':g(278),'w':g(256),'h':g(257),'compression':g(259),'planar':g(284),'bps':g(258),'nstrips_or_tiles':(tags.get(324) or tags.get(273) or (0,0,0))[1],'spp':g(277),'photometric':g(262),'ifd0_off':off}
def one(a):
    src,u=a
    try:
        def read(x,y): return rng(u,x,y)
        r=parse(read); r.update(src=src,url=u); return r
    except Exception as ex:
        return {'src':src,'url':u,'err':repr(ex)[:150]}
if __name__=='__main__':
    items=[l.rstrip('\n').split('\t') for l in open(sys.argv[1]) if l.strip()]
    with cf.ThreadPoolExecutor(6) as ex, open(sys.argv[2],'w') as f:
        for fu in cf.as_completed([ex.submit(one,i) for i in items]):
            f.write(json.dumps(fu.result())+'\n'); f.flush()

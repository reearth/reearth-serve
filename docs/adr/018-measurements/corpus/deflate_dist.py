#!/usr/bin/env python3 -I
"""Decode a raw deflate stream (bytes from a zip entry) and histogram LZ77 match distances.
usage: deflate_dist.py zipfile entry_index_or_name [max_out_bytes]  (reads local header, takes raw deflate data)"""
import sys,struct,json
LB=[3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258]
LE=[0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0]
DB=[1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577]
DE=[0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13]
class BR:
    def __init__(s,d): s.d=d; s.p=0; s.b=0; s.n=0
    def bits(s,k):
        while s.n<k: s.b|=s.d[s.p]<<s.n; s.p+=1; s.n+=8
        v=s.b&((1<<k)-1); s.b>>=k; s.n-=k; return v
def build(lens):
    mx=max(lens) or 1; cnt=[0]*(mx+1)
    for l in lens: cnt[l]+=1
    cnt[0]=0; code=0; nxt=[0]*(mx+2)
    for i in range(1,mx+1): code=(code+cnt[i-1])<<1; nxt[i]=code
    t={}
    for s,l in enumerate(lens):
        if l: t[(l,nxt[l])]=s; nxt[l]+=1
    return t,mx
def dec(br,tb):
    t,mx=tb; c=0
    for l in range(1,mx+1):
        c=(c<<1)|br.bits(1)
        if (l,c) in t: return t[(l,c)]
    raise ValueError('bad code')
def inflate_dist(data,limit):
    br=BR(data); dists=[]; out=0; lits=0; matches=0; mbytes=0
    fixl=build([8]*144+[9]*112+[7]*24+[8]*8); fixd=build([5]*30)
    while out<limit:
        final=br.bits(1); typ=br.bits(2)
        if typ==0:
            br.b=0; br.n=0; ln=data[br.p]|data[br.p+1]<<8; br.p+=4; br.p+=ln; out+=ln; lits+=ln
        else:
            if typ==1: lt,dt=fixl,fixd
            else:
                hl=br.bits(5)+257; hd=br.bits(5)+1; hc=br.bits(4)+4
                order=[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]; cl=[0]*19
                for i in range(hc): cl[order[i]]=br.bits(3)
                ct=build(cl); lens=[]
                while len(lens)<hl+hd:
                    s=dec(br,ct)
                    if s<16: lens.append(s)
                    elif s==16: lens+= [lens[-1]]*(3+br.bits(2))
                    elif s==17: lens+=[0]*(3+br.bits(3))
                    else: lens+=[0]*(11+br.bits(7))
                lt=build(lens[:hl]); dt=build(lens[hl:hl+hd])
            while True:
                s=dec(br,lt)
                if s<256: out+=1; lits+=1
                elif s==256: break
                else:
                    s-=257; ln=LB[s]+br.bits(LE[s]); ds=dec(br,dt); d=DB[ds]+br.bits(DE[ds])
                    dists.append(d); out+=ln; matches+=1; mbytes+=ln
                if out>=limit: break
        if final: break
    return dists,out,lits,matches,mbytes
if __name__=='__main__':
    path=sys.argv[1]; name=sys.argv[2]; limit=int(sys.argv[3]) if len(sys.argv)>3 else 64<<20
    z=open(path,'rb').read()
    i=z.rfind(b'PK\x05\x06'); n,cdsz,cdoff=struct.unpack('<HII',z[i+10:i+20]); p=cdoff; hit=None
    for _ in range(n):
        (_,_,_,fl,m,_,_,_,c,us,nl,el,cl,_,_,_,off)=struct.unpack('<IHHHHHHIIIHHHHHII',z[p:p+46]); nm=z[p+46:p+46+nl].decode('latin1')
        if nm.endswith(name) or name==str(_): hit=(nm,m,c,us,off); break
        p+=46+nl+el+cl
    nm,m,c,us,off=hit; nl,el=struct.unpack('<HH',z[off+26:off+30]); st=off+30+nl+el
    assert m==8,m
    dists,out,lits,matches,mb=inflate_dist(z[st:st+c],limit)
    N=len(dists); res={'entry':nm,'usize':us,'csize':c,'decoded_bytes':out,'literals':lits,'matches':N,'match_bytes':mb,'lit_share_of_output':lits/out}
    for k in (1024,2048,4096,8192,16384,24576): res[f'matches_gt_{k}']=sum(d>k for d in dists)/N
    wb=0
    res['match_bytes_gt_4096_share']=None
    json.dump(res,sys.stdout,indent=1)

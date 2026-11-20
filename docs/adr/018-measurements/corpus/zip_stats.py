#!/usr/bin/env python3 -I
import sys,json,re,collections
def pct(v,q):
    v=sorted(v); 
    if not v: return None
    k=(len(v)-1)*q; f=int(k); c=min(f+1,len(v)-1); return v[f]+(v[c]-v[f])*(k-f)
def summ(rows,label):
    ok=[r for r in rows if 'err' not in r]
    if not ok: print(label,'none'); return
    n=[r['parsed_n'] for r in ok]; cd=[r['cd_bytes'] for r in ok]; sz=[r['size'] for r in ok]
    ent=sum(n)
    print(f"== {label}: zips={len(ok)} (errors {len(rows)-len(ok)}) total_size={sum(sz)/1e9:.1f}GB")
    print("  entries p50/p90/p99/max:",*[int(pct(n,q)) for q in (.5,.9,.99,1)])
    print("  cd_bytes p50/p90/p99/max:",*[int(pct(cd,q)) for q in (.5,.9,.99,1)])
    print("  size_bytes p50/p90/p99/max:",*[int(pct(sz,q)) for q in (.5,.9,.99,1)])
    print("  zip64:",sum(r['zip64'] for r in ok),"  zips w/ >=1 data-descriptor entry:",sum(r['dd']>0 for r in ok),f" entry-share w/ DD: {sum(r['dd'] for r in ok)/ent:.3f}")
    mc=collections.Counter()
    for r in ok:
        for m,c in r['methods'].items(): mc[m]+=c
    print("  methods (entry counts):",dict(mc)," zips w/ method other than 0/8:",sum(any(m not in('0','8') for m in r['methods']) for r in ok))
    print(f"  entries without UTF-8 flag: {sum(r['nonutf_flag'] for r in ok)/ent:.3f}; nonASCII names: {sum(r['nonascii'] for r in ok)}, of which no UTF-8 flag: {sum(r['nonascii_nonutf'] for r in ok)}")
    print("  declared!=parsed:",sum(r['declared_n']!=r['parsed_n'] for r in ok),"  dir entries:",sum(r['dirs'] for r in ok))
    big=[r for r in ok if r['size']>1<<30]; print("  zips>1GiB:",len(big),"entries p50",int(pct([r['parsed_n'] for r in big],.5)) if big else None)
rows=[json.loads(l) for l in open(sys.argv[1])]
def kind(u):
    f=u.split('/')[-1]
    for k in ('citygml','3dtiles_mvt','3dtiles-mvt','3Dtiles_etc','related','ortho','obj','fbx','other','czml'):
        if k.lower() in f.lower(): return k
    return 'misc'
by=collections.defaultdict(list)
for r in rows: by[kind(r['url'])].append(r)
summ(rows,'ALL')
for k,v in sorted(by.items(),key=lambda kv:-len(kv[1])): 
    if len(v)>=5: summ(v,k)
if len(sys.argv)>2:
    tag=sys.argv[2]; print([r.get('err') for r in rows if 'err' in r][:5])

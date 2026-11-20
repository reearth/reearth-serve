#!/usr/bin/env python3 -I
import json,collections,sys
r=[json.loads(l) for f in sys.argv[1:] for l in open(f)]
c=collections.defaultdict(collections.Counter); det=collections.defaultdict(collections.Counter)
for x in r:
    if 'err' in x: k='err'
    else: k='tiled' if x['tiled'] else ('strip' if x['stripped'] else 'other')
    c[x['src']][k]+=1
    if k=='strip': det[x['src']]['rps=%s'%x['rps']]+=1
    if k=='tiled': det[x['src']]['tile=%sx%s'%(x['tilew'],x['tileh'])]+=1
    if 'err' not in x: det[x['src']]['comp=%s'%x['compression']]+=1; det[x['src']]['big' if x['bigtiff'] else 'classic']+=1
T=collections.Counter()
for s,v in sorted(c.items()):
    print(f"{s}: {dict(v)}  | {dict(det[s].most_common(6))}"); T.update(v)
print('TOTAL',dict(T))
errs=collections.Counter((x['src'],x['err'][:60]) for x in r if 'err' in x); print(errs.most_common(6))
